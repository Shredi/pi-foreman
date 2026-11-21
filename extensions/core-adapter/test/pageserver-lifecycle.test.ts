// The page server process (pageserver.ts `startPageServer`, `loadPagesConfig`): config rules, bind, port fallback, re-read exits, Host update, idle exit, log content.
// Real sockets on loopback, injected clock, config and exit.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { IDLE_EXIT_MS, httpHealth, loadPagesConfig, logFile, pagesStateDir, readServer, registerRoot, rootsDir, serverFile, servedUrl, startPageServer } from "../pageserver.ts";
import type { CfgResult, PageServer, PagesCfg, ServeDeps } from "../pageserver.ts";
import type { Spawner } from "../spawn.ts";
import { PROBE_CODE } from "../python.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posix } from "./_platform.ts";

let tmp: string;
let agentDir: string;
let clock: number;
let logs: string[];
let exits: number[];
let cfg: CfgResult;
let started: PageServer[];
let foreign: net.Server[];

const okCfg = (over: Partial<PagesCfg> = {}): CfgResult => ({ ok: true, cfg: { enabled: true, port: 0, bind: "127.0.0.1", baseUrl: "", ...over } });

function deps(over: Partial<ServeDeps> = {}): ServeDeps {
  return { agentDir, version: "1.2.3", now: () => clock, loadConfig: async () => cfg, log: (l) => logs.push(l), exit: (c) => exits.push(c), ...over };
}

async function start(over: Partial<ServeDeps> = {}): Promise<PageServer | null> {
  const s = await startPageServer(deps(over));
  if (s) started.push(s);
  return s;
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const hold = (port: number): Promise<net.Server> =>
  new Promise((resolve) => {
    const s = net.createServer((c) => c.destroy()).listen(port, "127.0.0.1", () => resolve(s));
    foreign.push(s);
  });

const request = (port: number, p: string, host?: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers: { Host: host ?? `127.0.0.1:${port}` }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

beforeEach(() => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-life-"));
  agentDir = path.join(tmp, "agent");
  clock = 1_000_000;
  logs = [];
  exits = [];
  cfg = okCfg();
  started = [];
  foreign = [];
});
afterEach(async () => {
  for (const s of started) s.shutdown(0, "test end");
  for (const f of foreign) await new Promise((r) => f.close(r));
  rmTestTmp(tmp);
});

test("it starts on the configured port and bind, writes server.json atomically with mode 0600, and answers its health", async () => {
  const port = await freePort();
  cfg = okCfg({ port });
  const s = await start();
  assert.ok(s);
  assert.equal(s.port, port);
  const rec = readServer(pagesStateDir(agentDir));
  assert.ok(rec);
  assert.deepEqual({ pid: rec.pid, port: rec.port, configPort: rec.configPort, bind: rec.bind, version: rec.version }, { pid: process.pid, port, configPort: port, bind: "127.0.0.1", version: "1.2.3" });
  assert.equal(fs.readdirSync(pagesStateDir(agentDir)).filter((n) => n.endsWith(".tmp")).length, 0);
  if (posix) {
    assert.equal(fs.statSync(serverFile(pagesStateDir(agentDir))).mode & 0o777, 0o600);
    assert.equal(fs.statSync(pagesStateDir(agentDir)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(rootsDir(pagesStateDir(agentDir))).mode & 0o777, 0o700);
  }
  const h = await httpHealth(rec);
  assert.deepEqual(h, { pid: process.pid, version: "1.2.3", port, bind: "127.0.0.1" });
  assert.equal(await httpHealth({ ...rec, healthKey: "wrong" }), null);
});

test("the log file holds start and exit lines only, never a request path or a root id", async () => {
  const state = pagesStateDir(agentDir);
  const { realServeDeps } = await import("../pageserver.ts");
  const port = await freePort();
  const real = realServeDeps({ PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
  const s = await startPageServer({ ...real, loadConfig: async () => okCfg({ port }), exit: (c) => exits.push(c) });
  assert.ok(s);
  started.push(s);
  const pages = path.join(tmp, "ws", "show", "sid", "pages");
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(pages, "plan.html"), "x");
  const id = registerRoot(state, pages, "dir");
  assert.ok(id);
  await request(port, `/${id}/plan.html`);
  await request(port, `/${id}/missing.html`);
  await request(port, "/nonsense/path?secret=1");
  s.shutdown(0, "test");
  const log = fs.readFileSync(logFile(state), "utf8");
  assert.match(log, /start pid \d+ version .* port \d+ bind 127\.0\.0\.1/);
  assert.match(log, /exit test/);
  for (const bad of [id, "plan.html", "missing", "nonsense", "secret", "GET"]) assert.ok(!log.includes(bad), bad);
  assert.equal(log.trim().split("\n").length, 2);
});

test("a non-loopback bind logs one line naming the address", async () => {
  cfg = okCfg({ bind: "0.0.0.0" });
  const s = await start();
  assert.ok(s);
  assert.ok(logs.some((l) => l.includes("bind 0.0.0.0 is not loopback")));
  const loop = logs.length;
  s.shutdown(0, "x");
  assert.ok(logs.length > loop);
});

test("enabled false: no start, no listener, no server.json", async () => {
  cfg = okCfg({ enabled: false });
  assert.equal(await start(), null);
  assert.deepEqual(exits, [0]);
  assert.equal(readServer(pagesStateDir(agentDir)), null);
});

test("a failed config call: no start", async () => {
  cfg = { ok: false, why: "no Python 3.13 for the config call" };
  assert.equal(await start(), null);
  assert.deepEqual(exits, [1]);
  assert.equal(readServer(pagesStateDir(agentDir)), null);
  assert.ok(logs[0].startsWith("not started"));
});

// loadPagesConfig through a fake Python and config CLI
const fakeSpawner = (config: { stdout?: string; code?: number; python?: boolean }): Spawner => async (_cmd, args) => {
  if (args.includes(PROBE_CODE)) return config.python === false ? { code: 1, stdout: "", stderr: "", timedOut: false } : { code: 0, stdout: "3.13\n/usr/bin/python3\n/usr/bin/python3\n/usr\n", stderr: "", timedOut: false };
  return { code: config.code ?? 0, stdout: config.stdout ?? "", stderr: "", timedOut: false };
};
const cliOut = (server: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ config: { pages: { server } }, warnings: [], errors: [], safetyFallback: false, roles: {}, ...extra });
const good = { enabled: true, port: 47317, bind: "127.0.0.1", baseUrl: "" };

test("loadPagesConfig: a working config call gives the keys", async () => {
  const r = await loadPagesConfig({ agentDir, pkgRoot: path.resolve(import.meta.dirname, "..", "..", ".."), env: {}, spawner: fakeSpawner({ stdout: cliOut({ ...good, baseUrl: "https://box.example" }) }) });
  assert.deepEqual(r, { ok: true, cfg: { ...good, baseUrl: "https://box.example" } });
});

test("loadPagesConfig: no Python, a defaults-only result and a config error are failures (the server does not start)", async () => {
  const pkgRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const noPy = await loadPagesConfig({ agentDir, pkgRoot, env: {}, spawner: fakeSpawner({ python: false }) });
  assert.equal(noPy.ok, false);
  const unreadable = await loadPagesConfig({ agentDir, pkgRoot, env: {}, spawner: fakeSpawner({ stdout: "not json", code: 1 }) });
  assert.equal(unreadable.ok, false);
  const withError = await loadPagesConfig({ agentDir, pkgRoot, env: {}, spawner: fakeSpawner({ stdout: cliOut(good, { errors: ["user foreman.json: unreadable"] }) }) });
  assert.equal(withError.ok, false);
  assert.match(withError.why ?? "", /config error/);
  const fallback = await loadPagesConfig({ agentDir, pkgRoot, env: {}, spawner: fakeSpawner({ stdout: cliOut(good, { safetyFallback: true }) }) });
  assert.equal(fallback.ok, false);
  for (const bad of [{ ...good, enabled: "yes" }, { ...good, port: "47317" }, { ...good, bind: "" }, { ...good, baseUrl: "ftp://x" }, undefined]) {
    const r = await loadPagesConfig({ agentDir, pkgRoot, env: {}, spawner: fakeSpawner({ stdout: cliOut(bad) }) });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  // and a startPageServer fed by such a result does not start
  cfg = withError;
  assert.equal(await start(), null);
  assert.deepEqual(exits, [1]);
});

test("a foreign listener on the port: the server takes a free port, records both, links use the free port, and a set baseUrl gives no URL", async () => {
  const port = await freePort();
  await hold(port);
  cfg = okCfg({ port });
  const s = await start();
  assert.ok(s);
  assert.notEqual(s.port, port);
  const rec = readServer(pagesStateDir(agentDir));
  assert.ok(rec);
  assert.equal(rec.port, s.port);
  assert.equal(rec.configPort, port);
  assert.equal(servedUrl(rec, { baseUrl: "" }, "ID", "plan.html"), `http://127.0.0.1:${s.port}/ID/plan.html`);
  assert.equal(servedUrl(rec, { baseUrl: "https://box.example" }, "ID", "plan.html"), null);
});

test("after a fallback the 60 s config check does not exit", async () => {
  const port = await freePort();
  await hold(port);
  cfg = okCfg({ port });
  const s = await start();
  assert.ok(s);
  await s.recheck();
  assert.deepEqual(exits, []);
  assert.equal(s.closed(), false);
});

test("a restart reuses the last recorded port when it is free", async () => {
  const port = await freePort();
  await hold(port);
  cfg = okCfg({ port });
  const a = await start();
  assert.ok(a);
  const last = a.port;
  a.shutdown(0, "restart");
  exits.length = 0;
  const b = await start();
  assert.ok(b);
  assert.equal(b.port, last);
});

test("a healthy pi-foreman server on the port is reused: the second does not start", async () => {
  const port = await freePort();
  cfg = okCfg({ port });
  const a = await start({ pid: 4242 });
  assert.ok(a);
  const before = readServer(pagesStateDir(agentDir));
  assert.equal(await start({ pid: 4343 }), null);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(readServer(pagesStateDir(agentDir)), before);
});

test("the re-read exits on a failed read, on enabled false, on a changed port and on a changed bind", async () => {
  const port = await freePort();
  for (const [next, code] of [[{ ok: false, why: "unreadable" } as CfgResult, 1], [okCfg({ port, enabled: false }), 0], [okCfg({ port: port + 1 }), 0], [okCfg({ port, bind: "127.0.0.2" }), 0]] as const) {
    exits = [];
    logs = [];
    cfg = okCfg({ port });
    const s = await start();
    assert.ok(s);
    await s.recheck();
    assert.deepEqual(exits, []);
    cfg = next;
    await s.recheck();
    assert.deepEqual(exits, [code], JSON.stringify(next));
    assert.ok(logs.at(-1)?.startsWith("exit "));
    assert.equal(s.closed(), true);
    await new Promise((r) => setTimeout(r, 20));
  }
});

test("a changed baseUrl updates the Host check without a restart", async () => {
  const port = await freePort();
  cfg = okCfg({ port });
  const state = pagesStateDir(agentDir);
  const s = await start();
  assert.ok(s);
  const pages = path.join(tmp, "ws", "show", "sid", "pages");
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(pages, "plan.html"), "x");
  const id = registerRoot(state, pages, "dir");
  assert.equal((await request(port, `/${id}/plan.html`, "box.vpn.example")).status, 404);
  cfg = okCfg({ port, baseUrl: "https://box.vpn.example:8443" });
  await s.recheck();
  assert.deepEqual(exits, []);
  assert.equal((await request(port, `/${id}/plan.html`, "box.vpn.example")).status, 200);
  assert.equal((await request(port, `/${id}/plan.html`, "other.example")).status, 404);
  cfg = okCfg({ port });
  await s.recheck();
  assert.equal((await request(port, `/${id}/plan.html`, "box.vpn.example")).status, 404);
});

test("idle exit after 12 hours with no request and no root touched (injected clock)", async () => {
  const port = await freePort();
  cfg = okCfg({ port });
  const state = pagesStateDir(agentDir);
  const s = await start();
  assert.ok(s);
  clock += IDLE_EXIT_MS - 1000;
  s.idleCheck();
  assert.deepEqual(exits, []);
  // a request resets the idle time
  await request(port, "/x");
  clock += IDLE_EXIT_MS - 1000;
  s.idleCheck();
  assert.deepEqual(exits, []);
  // so does a root touched by a session
  const pages = path.join(tmp, "p");
  fs.mkdirSync(pages);
  clock += 2000;
  registerRoot(state, pages, "dir", clock);
  clock += IDLE_EXIT_MS - 1000;
  s.idleCheck();
  assert.deepEqual(exits, []);
  clock += 2000;
  s.idleCheck();
  assert.deepEqual(exits, [0]);
  assert.match(logs.at(-1) ?? "", /idle for 12 hours/);
});
