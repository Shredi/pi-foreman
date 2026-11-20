// The page server (docs/pages.md): one small HTTP server per machine serves the harness pages (the pages/ folder of a session's show dir, single brief files)
// behind one capability secret per registered root. This module holds the state files (<agent dir>/pi-foreman/state/pages/), the request handler, the server
// lifecycle (`startPageServer`, run by `foreman pages serve`) and the client side a session uses (`ensureServer`, `registerRoot`, `pageUrlFor`).
// The server never writes a request path or a root id anywhere (the secret is in the path); its log file holds start, bind and exit lines only.
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { get, loadMergedConfig, pythonPathHint } from "./config.ts";
import type { Json } from "./config.ts";
import { piAgentDir } from "./env.ts";
import { renderPage } from "./pages.ts";
import { resolvePython } from "./python.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";
import { dropLock, takeLock, writeAtomic } from "./statefile.ts";

export const DEFAULT_PORT = 47317;
export const ROOT_KEEP_MS = 7 * 24 * 3_600_000;
export const IDLE_EXIT_MS = 12 * 3_600_000;
export const RECHECK_MS = 60_000;
export const IDLE_CHECK_MS = 10 * 60_000;
export const ENSURE_CACHE_MS = 60_000;
const HEALTH_TIMEOUT_MS = 1000;
const START_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const LOG_MAX_BYTES = 64 * 1024;
const ROOT_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export type RootKind = "dir" | "file";

export interface RootRecord {
  path: string;
  kind: RootKind;
  touchedAt: number;
}

export interface ServerRecord {
  pid: number;
  port: number;
  /** The port pages.server.port named when the server started; `port` differs after a fallback to a free port. */
  configPort: number;
  bind: string;
  version: string;
  startedAt: number;
  healthKey: string;
}

export interface Health {
  pid: number;
  version: string;
  port: number;
  bind: string;
}

export type CfgResult = { ok: true; cfg: PagesCfg; why?: undefined } | { ok: false; why: string; cfg?: undefined };

export interface PagesCfg {
  enabled: boolean;
  port: number;
  bind: string;
  baseUrl: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const win = process.platform === "win32";

// ---------------------------------------------------------------- state paths

export const pagesStateDir = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "pages");
export const serverFile = (stateDir: string): string => path.join(stateDir, "server.json");
export const rootsDir = (stateDir: string): string => path.join(stateDir, "roots");
export const lockFile = (stateDir: string): string => path.join(stateDir, "serve.lock");
export const logFile = (stateDir: string): string => path.join(stateDir, "server.log");

/** The state dir and its roots dir, mode 0700. */
export function ensureStateDirs(stateDir: string): void {
  for (const d of [stateDir, rootsDir(stateDir)]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (!win) {
      try {
        fs.chmodSync(d, 0o700);
      } catch {
        // not ours to change
      }
    }
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readServer(stateDir: string): ServerRecord | null {
  const j = readJson(serverFile(stateDir));
  if (!isObj(j)) return null;
  const { pid, port, configPort, bind, version, startedAt, healthKey } = j;
  if (!Number.isInteger(pid) || (pid as number) <= 0 || !Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) return null;
  if (typeof bind !== "string" || typeof version !== "string" || typeof healthKey !== "string" || !healthKey || typeof startedAt !== "number") return null;
  return { pid: pid as number, port: port as number, configPort: Number.isInteger(configPort) ? (configPort as number) : (port as number), bind, version, startedAt, healthKey };
}

// ---------------------------------------------------------------- roots

const realOf = (p: string): string => fs.realpathSync.native(p);
const samePath = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

function readRoot(file: string): RootRecord | null {
  const j = readJson(file);
  if (!isObj(j) || typeof j.path !== "string" || (j.kind !== "dir" && j.kind !== "file") || typeof j.touchedAt !== "number") return null;
  return { path: j.path, kind: j.kind, touchedAt: j.touchedAt };
}

/** Roots with no touch for 7 days are deleted. */
export function pruneRoots(stateDir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(rootsDir(stateDir));
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const file = path.join(rootsDir(stateDir), n);
    const r = readRoot(file);
    if (r && now - r.touchedAt > ROOT_KEEP_MS) {
      try {
        fs.unlinkSync(file);
      } catch {
        // gone meanwhile
      }
    }
  }
}

/** Registers the real path of `absPath` as a root and returns its id (the capability); a root with the same real path and kind is reused and touched. Null: not a dir or file as `kind` says. */
export function registerRoot(stateDir: string, absPath: string, kind: RootKind, now: number = Date.now()): string | null {
  let real: string;
  try {
    real = realOf(absPath);
    const st = fs.statSync(real);
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return null;
  } catch {
    return null;
  }
  try {
    ensureStateDirs(stateDir);
    pruneRoots(stateDir, now);
    for (const n of fs.readdirSync(rootsDir(stateDir))) {
      const id = n.slice(0, -".json".length);
      if (!n.endsWith(".json") || !ROOT_ID_RE.test(id)) continue;
      const r = readRoot(path.join(rootsDir(stateDir), n));
      if (r && r.kind === kind && samePath(r.path, real)) {
        writeAtomic(path.join(rootsDir(stateDir), n), { ...r, touchedAt: now });
        return id;
      }
    }
    const id = randomBytes(32).toString("base64url");
    writeAtomic(path.join(rootsDir(stateDir), `${id}.json`), { path: real, kind, touchedAt: now } satisfies RootRecord);
    return id;
  } catch {
    return null;
  }
}

/** Deletes every root record (every link dies); returns how many. */
export function rotateRoots(stateDir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(rootsDir(stateDir))) {
      if (!f.endsWith(".json")) continue;
      try {
        fs.unlinkSync(path.join(rootsDir(stateDir), f));
        n++;
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // no roots dir
  }
  return n;
}

export function countRoots(stateDir: string): number {
  try {
    return fs.readdirSync(rootsDir(stateDir)).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function lastRootTouch(stateDir: string): number {
  let max = 0;
  try {
    for (const n of fs.readdirSync(rootsDir(stateDir))) {
      const r = n.endsWith(".json") ? readRoot(path.join(rootsDir(stateDir), n)) : null;
      if (r && r.touchedAt > max) max = r.touchedAt;
    }
  } catch {
    // none
  }
  return max;
}

// ---------------------------------------------------------------- URLs

/** `<base>/<id>/<relpath>`; null when `baseUrl` is set and the server listens on another port than configured (links use the base as written). */
export function servedUrl(rec: ServerRecord, cfg: { baseUrl: string }, id: string, relpath: string): string | null {
  const base = cfg.baseUrl ? cfg.baseUrl.replace(/\/+$/, "") : `http://127.0.0.1:${rec.port}`;
  if (cfg.baseUrl && rec.port !== rec.configPort) return null;
  return `${base}/${id}/${relpath.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------------------------------------------------------------- config

/** pages.server of a merged config, strictly: null `why` text on a malformed value (the server then does not start). */
export function parsePagesCfg(config: Json): CfgResult {
  const s = get(config, "pages.server");
  if (!isObj(s)) return { ok: false, why: "pages.server missing" };
  const { enabled, port, bind, baseUrl } = s;
  if (typeof enabled !== "boolean") return { ok: false, why: "pages.server.enabled is not a boolean" };
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) return { ok: false, why: "pages.server.port is not a port" };
  if (typeof bind !== "string" || !bind.trim()) return { ok: false, why: "pages.server.bind is empty" };
  if (typeof baseUrl !== "string") return { ok: false, why: "pages.server.baseUrl is not a string" };
  if (baseUrl && hostOfBase(baseUrl) === null) return { ok: false, why: "pages.server.baseUrl is not an http(s) URL" };
  return { ok: true, cfg: { enabled, port: port as number, bind: bind.trim(), baseUrl: baseUrl.trim() } };
}

/** A session's effective config as the client reads it: on unless `enabled` is false. */
export function clientCfg(config: Json | undefined): { enabled: boolean; baseUrl: string } {
  const s = get(config, "pages.server");
  const baseUrl = isObj(s) && typeof s.baseUrl === "string" ? s.baseUrl.trim() : "";
  return { enabled: !(isObj(s) && s.enabled === false), baseUrl: baseUrl && hostOfBase(baseUrl) !== null ? baseUrl : "" };
}

/** The config the server and `foreman pages` act on: defaults, overlay and user layers only (trusted:false, no project). A defaults-only result or any config error is a failure. */
export async function loadPagesConfig(input: { agentDir: string; pkgRoot: string; env: NodeJS.ProcessEnv; spawner?: Spawner }): Promise<CfgResult> {
  const spawner = input.spawner ?? defaultSpawner;
  const hint = pythonPathHint(input.pkgRoot, input.agentDir);
  const py = await resolvePython({ configPath: hint, envPath: input.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner });
  if (!py.ok) return { ok: false, why: "no Python 3.13 for the config call" };
  const penv = Object.fromEntries(Object.entries(input.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const m = await loadMergedConfig({ python: py.info.executable, pkgRoot: input.pkgRoot, agentDir: input.agentDir, projectDir: input.agentDir, trusted: false, spawner, env: penv });
  if (m.source !== "cli" || m.safetyFallback) return { ok: false, why: `config call failed${m.fallbackReason ? `: ${m.fallbackReason}` : ""}` };
  if (m.errors.length > 0) return { ok: false, why: `config error: ${m.errors[0].slice(0, 160)}` };
  return parsePagesCfg(m.config);
}

// ---------------------------------------------------------------- request handler

export interface HostRules {
  bind: string;
  /** Host of pages.server.baseUrl, lower case, no port; null when unset. */
  baseHost: string | null;
}

export interface HandlerCtx {
  stateDir: string;
  hosts(): HostRules;
  /** The answer of GET /_health/<key>, with the key. */
  health(): { key: string; info: Health };
  /** Called on every request. */
  touch(): void;
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "sandbox allow-scripts allow-popups",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const reply = (status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}): Reply => {
  const b = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return { status, headers: { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(b.length), ...extra }, body: b };
};
const notFound = (): Reply => reply(404, "text/plain; charset=utf-8", "not found\n");

/** Host (no port) of an http(s) URL as the Host check compares it, or null. */
export function hostOfBase(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const bracket = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h).toLowerCase();

/** A Host header must name 127.0.0.1, localhost, [::1], the bind address or the baseUrl host (any port), else a DNS-rebinding page could read a page. */
export function hostAllowed(header: string | undefined, rules: HostRules): boolean {
  if (!header) return false;
  const h = header.trim().toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d*$/, "");
  if (!name) return false;
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === bracket(rules.bind) || (rules.baseHost !== null && name === bracket(rules.baseHost));
}

/** The segments of the request path after the id, each decoded once; null when one is unsafe. */
function segmentsOf(raw: string[]): string[] | null {
  const out: string[] = [];
  for (const r of raw) {
    let s: string;
    try {
      s = decodeURIComponent(r);
    } catch {
      return null;
    }
    if (s === "" || s.startsWith(".") || /[\\:\0/]/.test(s)) return null;
    out.push(s);
  }
  return out;
}

/** Opens `target` under the guarded-read rules of show.ts: no symlink in the last component, real path inside the root, one hard link, regular file, dev/ino of the opened handle equal to the lstat. */
export function readGuarded(rootReal: string, kind: RootKind, target: string): Buffer | null {
  let fd = -1;
  try {
    const lst = fs.lstatSync(target, { bigint: true });
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const real = realOf(target);
    if (kind === "file" ? !samePath(real, rootReal) : !(win ? real.toLowerCase() : real).startsWith((win ? rootReal.toLowerCase() : rootReal) + path.sep)) return null;
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.size > BigInt(MAX_FILE_BYTES)) return null;
    if (st.dev !== lst.dev || st.ino !== lst.ino) return null;
    const buf = Buffer.alloc(Number(st.size));
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return off === buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

function markdownPage(buf: Buffer, name: string): Buffer {
  const markdown = buf.toString("utf8");
  const title = (/^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || name;
  return Buffer.from(renderPage({ title, kicker: name, markdown, source: name }), "utf8");
}

/** One request. `rawUrl` is the request target; nothing of it is logged. */
export function handle(ctx: HandlerCtx, method: string, rawUrl: string, hostHeader: string | undefined): Reply {
  ctx.touch();
  if (!hostAllowed(hostHeader, ctx.hosts())) return notFound();
  if (method !== "GET" && method !== "HEAD") return reply(405, "text/plain; charset=utf-8", "method not allowed\n", { Allow: "GET, HEAD" });
  const pathPart = rawUrl.split(/[?#]/, 1)[0];
  if (!pathPart.startsWith("/")) return notFound();
  const raw = pathPart.slice(1).split("/");
  if (raw[0] === "_health") {
    const { key, info } = ctx.health();
    const given = Buffer.from(raw[1] ?? "");
    const want = Buffer.from(key);
    if (raw.length !== 2 || given.length !== want.length || !timingSafeEqual(given, want)) return notFound();
    return reply(200, "application/json", JSON.stringify(info));
  }
  const id = raw[0];
  if (!ROOT_ID_RE.test(id) || raw.length < 2) return notFound();
  const file = `${id}.json`;
  let known = false;
  try {
    known = fs.readdirSync(rootsDir(ctx.stateDir)).includes(file);
  } catch {
    known = false;
  }
  if (!known) return notFound();
  const root = readRoot(path.join(rootsDir(ctx.stateDir), file));
  if (!root) return notFound();
  const segs = segmentsOf(raw.slice(1));
  if (!segs) return notFound();
  let rootReal: string;
  try {
    rootReal = realOf(root.path);
  } catch {
    return notFound();
  }
  if (!samePath(rootReal, root.path)) return notFound();
  let target: string;
  if (root.kind === "file") {
    if (segs.length !== 1 || !samePath(segs[0], path.basename(root.path))) return notFound();
    target = root.path;
  } else {
    target = path.join(root.path, ...segs);
  }
  const name = segs[segs.length - 1];
  const ext = path.extname(name).toLowerCase();
  const type = TYPES[ext];
  if (!type) return notFound();
  const buf = readGuarded(rootReal, root.kind, target);
  if (!buf) return notFound();
  return reply(200, type, ext === ".md" ? markdownPage(buf, name) : buf);
}

// ---------------------------------------------------------------- health client

/** Connect address of a bind address (a wildcard bind is reached on loopback). */
export const connectHost = (bind: string): string => (bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind);

/** GET /_health/<key> within 1 s; null when nothing answers like a pi-foreman page server on that port. */
export function httpHealth(rec: ServerRecord, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Health | null> {
  return new Promise((resolve) => {
    const host = connectHost(rec.bind);
    let done = false;
    const finish = (h: Health | null): void => {
      if (done) return;
      done = true;
      resolve(h);
    };
    try {
      const req = http.get({ host, port: rec.port, path: `/_health/${rec.healthKey}`, timeout: timeoutMs, headers: { Host: `${bracket(host)}:${rec.port}` } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(null);
          return;
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
          if (text.length > 4096) req.destroy();
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(text) as Record<string, unknown>;
            finish(Number.isInteger(j.pid) && (j.pid as number) > 0 && typeof j.version === "string" && j.port === rec.port && typeof j.bind === "string" ? { pid: j.pid as number, version: j.version, port: rec.port, bind: j.bind } : null);
          } catch {
            finish(null);
          }
        });
        res.on("error", () => finish(null));
      });
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
      req.on("error", () => finish(null));
    } catch {
      finish(null);
    }
  });
}

// ---------------------------------------------------------------- server lifecycle

export interface ServeDeps {
  agentDir: string;
  version: string;
  now(): number;
  loadConfig(): Promise<CfgResult>;
  log(line: string): void;
  /** Ends the process (the real one) or records the code (tests). Called once. */
  exit(code: number): void;
  pid?: number;
  health?(rec: ServerRecord): Promise<Health | null>;
}

export interface PageServer {
  port: number;
  record: ServerRecord;
  /** The 60 s config check. */
  recheck(): Promise<void>;
  /** The 10 min idle check. */
  idleCheck(): void;
  /** Ends the server as the real exit paths do. */
  shutdown(code: number, why: string): void;
  hosts(): HostRules;
  closed(): boolean;
}

function listen(server: http.Server, port: number, bind: string): Promise<string | null> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => resolve(err.code ?? "ERROR");
    server.once("error", onError);
    server.listen({ port, host: bind }, () => {
      server.removeListener("error", onError);
      resolve(null);
    });
  });
}

/** Starts the server: config (no start on failure or enabled false), bind, port fallback (D5), server.json. Null: it did not start (`deps.exit` was called). */
export async function startPageServer(deps: ServeDeps): Promise<PageServer | null> {
  const stateDir = pagesStateDir(deps.agentDir);
  const pid = deps.pid ?? process.pid;
  const probe = deps.health ?? httpHealth;
  const cfgR = await deps.loadConfig();
  if (!cfgR.ok) {
    deps.log(`not started: ${cfgR.why}`);
    deps.exit(1);
    return null;
  }
  if (!cfgR.cfg.enabled) {
    deps.log("not started: pages.server.enabled is false");
    deps.exit(0);
    return null;
  }
  const start = cfgR.cfg;
  ensureStateDirs(stateDir);
  const healthKey = randomBytes(24).toString("base64url");
  let baseHost = start.baseUrl ? hostOfBase(start.baseUrl) : null;
  let lastActivity = deps.now();
  let ended = false;
  let record: ServerRecord;
  const hosts = (): HostRules => ({ bind: start.bind, baseHost });
  const info = (): Health => ({ pid, version: deps.version, port: record.port, bind: start.bind });
  const make = (): http.Server =>
    http.createServer((req, res) => {
      let r: Reply;
      try {
        r = handle({ stateDir, hosts, health: () => ({ key: healthKey, info: info() }), touch: () => { lastActivity = deps.now(); } }, req.method ?? "", req.url ?? "", req.headers.host);
      } catch {
        r = notFound();
      }
      res.writeHead(r.status, r.headers);
      res.end(req.method === "HEAD" ? undefined : r.body);
    });
  let server = make();
  let err = await listen(server, start.port, start.bind);
  if (err === "EADDRINUSE") {
    const prior = readServer(stateDir);
    if (prior && prior.pid !== pid && (await probe(prior))) {
      deps.log(`not started: a page server already runs on port ${prior.port}`);
      deps.exit(0);
      return null;
    }
    const tries = prior && prior.port !== start.port && prior.port > 0 ? [prior.port, 0] : [0];
    for (const p of tries) {
      server = make();
      err = await listen(server, p, start.bind);
      if (err !== "EADDRINUSE") break;
    }
  }
  if (err) {
    deps.log(`not started: listen failed (${err})`);
    deps.exit(1);
    return null;
  }
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : start.port;
  record = { pid, port, configPort: start.port, bind: start.bind, version: deps.version, startedAt: deps.now(), healthKey };
  try {
    writeAtomic(serverFile(stateDir), record);
  } catch (e) {
    deps.log(`not started: server.json not written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    server.close();
    deps.exit(1);
    return null;
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(start.bind);
  deps.log(`start pid ${pid} version ${deps.version} port ${port} bind ${start.bind}${port !== start.port ? ` (configured port ${start.port} was taken)` : ""}`);
  if (!loopback) deps.log(`bind ${start.bind} is not loopback: pages are reachable from the network behind their secrets`);

  const shutdown = (code: number, why: string): void => {
    if (ended) return;
    ended = true;
    // server.json stays: a dead record is replaced by the next start, and it names the last port a restart tries first (D5)
    deps.log(`exit ${why}`);
    server.close();
    server.closeAllConnections?.();
    deps.exit(code);
  };
  let busy = false;
  return {
    port,
    record,
    hosts,
    closed: () => ended,
    shutdown,
    async recheck() {
      if (busy || ended) return;
      busy = true;
      try {
        const r = await deps.loadConfig();
        if (ended) return;
        if (!r.ok) return shutdown(1, `config re-read failed: ${r.why}`);
        if (!r.cfg.enabled) return shutdown(0, "pages.server.enabled is false");
        if (r.cfg.port !== start.port || r.cfg.bind !== start.bind) return shutdown(0, "configured port or bind changed");
        baseHost = r.cfg.baseUrl ? hostOfBase(r.cfg.baseUrl) : null;
      } finally {
        busy = false;
      }
    },
    idleCheck() {
      if (ended) return;
      const last = Math.max(lastActivity, lastRootTouch(stateDir));
      if (deps.now() - last > IDLE_EXIT_MS) shutdown(0, "idle for 12 hours");
    },
  };
}

// ---------------------------------------------------------------- client: ensure

export function compareVersions(a: string, b: string): number {
  const n = (v: string): number[] => v.split("-")[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
  const x = n(a);
  const y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface EnsureDeps {
  agentDir: string;
  version: string;
  now(): number;
  health(rec: ServerRecord): Promise<Health | null>;
  /** Starts a detached server process. */
  spawnServer(): void;
  /** SIGTERM to the pid of an older healthy server. */
  kill(pid: number): void;
  sleep?(ms: number): Promise<void>;
  startWaitMs?: number;
  /** Cache of outcomes by call site; default: one per process. */
  cache?: Map<string, { at: number; result: Promise<ServerRecord | null> }>;
}

const processCache = new Map<string, { at: number; result: Promise<ServerRecord | null> }>();

/** The running server's record (started when none runs); null on any failure (links stay file links). The outcome, failure included, is cached for 60 s. */
export function ensureServer(deps: EnsureDeps): Promise<ServerRecord | null> {
  const cache = deps.cache ?? processCache;
  const hit = cache.get(deps.agentDir);
  if (hit && deps.now() - hit.at < ENSURE_CACHE_MS) return hit.result;
  const result = doEnsure(deps).catch(() => null);
  cache.set(deps.agentDir, { at: deps.now(), result });
  return result;
}

async function doEnsure(deps: EnsureDeps): Promise<ServerRecord | null> {
  const stateDir = pagesStateDir(deps.agentDir);
  const wait = deps.sleep ?? sleep;
  const startWait = deps.startWaitMs ?? START_WAIT_MS;
  const old = readServer(stateDir);
  if (old) {
    const h = await deps.health(old);
    if (h && compareVersions(h.version, deps.version) >= 0) return old;
    if (h && h.pid !== process.pid) {
      // a healthy older server: its health answer proves the pid; end it, wait until it stops answering
      deps.kill(h.pid);
      for (let i = 0; i < 20 && (await deps.health(old)); i++) await wait(50);
    }
  }
  ensureStateDirs(stateDir);
  const lock = lockFile(stateDir);
  const t0 = Date.now();
  const fresh = async (): Promise<ServerRecord | null> => {
    const r = readServer(stateDir);
    if (r && (!old || r.healthKey !== old.healthKey) && (await deps.health(r))) return r;
    return null;
  };
  let token = takeLock(lock, deps.now(), LOCK_STALE_MS);
  if (!token) {
    // another caller is starting it: wait for the same server
    while (Date.now() - t0 < startWait) {
      const r = await fresh();
      if (r) return r;
      await wait(50);
      token = takeLock(lock, deps.now(), LOCK_STALE_MS);
      if (token) break;
    }
    if (!token) return null;
  }
  try {
    const again = await fresh();
    if (again) return again;
    deps.spawnServer();
    while (Date.now() - t0 < startWait) {
      const r = await fresh();
      if (r) return r;
      await wait(50);
    }
    return null;
  } finally {
    dropLock(lock, token);
  }
}

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function pkgVersion(pkgRoot: string): string {
  const j = readJson(path.join(pkgRoot, "package.json"));
  return isObj(j) && typeof j.version === "string" ? j.version : "0.0.0";
}

/** Spawns `foreman pages serve` detached: no shell, no window, no stdio, own process group. */
export function spawnServeProcess(pkgRoot: string, agentDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", path.join(pkgRoot, "extensions", "core-adapter", "pages-cli.ts"), "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: fs.existsSync(pagesStateDir(agentDir)) ? pagesStateDir(agentDir) : os.homedir(),
    env: { ...env, PI_CODING_AGENT_DIR: agentDir },
  });
  child.on("error", () => undefined);
  child.unref();
}

export function realEnsureDeps(agentDir: string, pkgRoot: string = PKG_ROOT, env: NodeJS.ProcessEnv = process.env): EnsureDeps {
  return {
    agentDir,
    version: pkgVersion(pkgRoot),
    now: Date.now,
    health: httpHealth,
    spawnServer: () => spawnServeProcess(pkgRoot, agentDir, env),
    kill: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
    },
  };
}

// ---------------------------------------------------------------- client: URL for a page

/** A session on a remote machine (PI_FOREMAN_REMOTE_PARENT, SSH_CONNECTION) links served URLs only with its own baseUrl. */
export const isRemoteSession = (env: NodeJS.ProcessEnv): boolean => env.PI_FOREMAN_REMOTE_PARENT === "1" || !!env.SSH_CONNECTION;

export interface PageUrlDeps {
  env: NodeJS.ProcessEnv;
  agentDir: string;
  ensure(): Promise<ServerRecord | null>;
  now(): number;
}

/**
 * The served URL of the page file `absPath`, for UI lines only (never a tool result, never a project file). `kind` "dir": its folder is the root (a show pages/ folder);
 * "file": the file itself is the root (a brief). `config` is the session's effective config. Null whenever the link must stay a file link: disabled, a remote session
 * without baseUrl, the server cannot start, `baseUrl` set while the server fell back to a free port, or the path is not a dir/file as `kind` says.
 */
export async function pageUrlFor(absPath: string, kind: RootKind, config?: Json, deps: Partial<PageUrlDeps> = {}): Promise<string | null> {
  try {
    const env = deps.env ?? process.env;
    const cfg = clientCfg(config);
    if (!cfg.enabled) return null;
    if (isRemoteSession(env) && !cfg.baseUrl) return null;
    const agentDir = deps.agentDir ?? piAgentDir(env, env.HOME ?? env.USERPROFILE ?? os.homedir());
    const rec = await (deps.ensure ? deps.ensure() : ensureServer(realEnsureDeps(agentDir, PKG_ROOT, env)));
    if (!rec) return null;
    const stateDir = pagesStateDir(agentDir);
    const id = registerRoot(stateDir, kind === "dir" ? path.dirname(absPath) : absPath, kind, (deps.now ?? Date.now)());
    if (!id) return null;
    return servedUrl(rec, cfg, id, path.basename(absPath));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- real serve deps

export function realServeDeps(env: NodeJS.ProcessEnv = process.env, pkgRoot: string = PKG_ROOT): ServeDeps {
  const agentDir = piAgentDir(env, env.HOME ?? env.USERPROFILE ?? os.homedir());
  const stateDir = pagesStateDir(agentDir);
  return {
    agentDir,
    version: pkgVersion(pkgRoot),
    now: Date.now,
    loadConfig: () => loadPagesConfig({ agentDir, pkgRoot, env }),
    log: (line) => {
      try {
        ensureStateDirs(stateDir);
        const f = logFile(stateDir);
        let big = false;
        try {
          big = fs.statSync(f).size > LOG_MAX_BYTES;
        } catch {
          // no log yet
        }
        fs.writeFileSync(f, `${new Date().toISOString()} ${line}\n`, { flag: big ? "w" : "a", mode: 0o600 });
      } catch {
        // no log
      }
    },
    exit: (code) => {
      setTimeout(() => process.exit(code), 50).unref();
    },
  };
}
