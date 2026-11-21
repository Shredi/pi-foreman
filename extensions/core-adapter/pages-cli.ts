// `foreman pages serve|ensure|url <path>|status|stop|rotate` (bin/foreman, .cmd, .ps1): the page server of docs/pages.md.
// `serve` is the server process itself (a session or herdr-app starts it through `ensure`); `url` prints the served URL of one page file of a show pages/ folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piAgentDir } from "./env.ts";
import { ID_RE } from "./show.ts";
import { countRoots, ensureServer, httpHealth, IDLE_CHECK_MS, loadPagesConfig, PKG_ROOT, pagesStateDir, readServer, realEnsureDeps, realServeDeps, RECHECK_MS, registerRoot, rotateRoots, servedUrl, startPageServer } from "./pageserver.ts";
import type { CfgResult, EnsureDeps, Health, ServeDeps, ServerRecord } from "./pageserver.ts";

export const USAGE = "usage: foreman pages serve|ensure|url <path>|status|stop|rotate";

/** Copy of PAGE_FILE in integrations/herdr-app/pi-foreman-plan/model.js:148 (a mod cannot import this package): the names `fileOfId` in pages.ts makes. */
const PAGE_FILE = /^(?:plan|result|note-\d{1,6})\.html$/;

export interface CliDeps {
  agentDir: string;
  pkgRoot: string;
  now(): number;
  loadConfig(): Promise<CfgResult>;
  ensureDeps(): EnsureDeps;
  health(rec: ServerRecord): Promise<Health | null>;
  kill(pid: number): void;
  /** `serve`: runs the server until it exits; resolves with the exit code. */
  serve(): Promise<number>;
}

/** The real path of a page file of a show pages/ folder (`.../show/<id>/pages/<name>`), or null: anything else is refused. */
export function pageFileOf(p: string): string | null {
  try {
    if (!path.isAbsolute(p)) return null;
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink !== 1) return null;
    const real = fs.realpathSync.native(p);
    const parts = real.split(/[\\/]/);
    const n = parts.length;
    if (n < 5 || parts[n - 4] !== "show" || !ID_RE.test(parts[n - 3]) || parts[n - 3] === "." || parts[n - 3] === ".." || parts[n - 2] !== "pages" || !PAGE_FILE.test(parts[n - 1])) return null;
    const st = fs.statSync(real);
    return st.isFile() && st.nlink === 1 ? real : null;
  } catch {
    return null;
  }
}

export function realCliDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  const agentDir = piAgentDir(env, env.HOME ?? env.USERPROFILE ?? os.homedir());
  const sd = realServeDeps(env, PKG_ROOT);
  return {
    agentDir,
    pkgRoot: PKG_ROOT,
    now: Date.now,
    loadConfig: () => loadPagesConfig({ agentDir, pkgRoot: PKG_ROOT, env }),
    ensureDeps: () => realEnsureDeps(agentDir, PKG_ROOT, env),
    health: httpHealth,
    kill: (pid) => process.kill(pid, "SIGTERM"),
    serve: () => runServe(sd),
  };
}

/** The server process: starts, then checks its config every minute and its idleness every ten, until it exits. */
export async function runServe(deps: ServeDeps): Promise<number> {
  return new Promise<number>((resolve) => {
    let timers: NodeJS.Timeout[] = [];
    let code = 0;
    const real = deps.exit;
    const wrapped: ServeDeps = {
      ...deps,
      exit: (c) => {
        code = c;
        for (const t of timers) clearInterval(t);
        timers = [];
        real(c);
        resolve(c);
      },
    };
    startPageServer(wrapped).then((s) => {
      if (!s) return;
      timers = [setInterval(() => void s.recheck().catch(() => s.shutdown(1, "config re-read failed")), RECHECK_MS), setInterval(() => s.idleCheck(), IDLE_CHECK_MS)];
      const stop = (): void => s.shutdown(0, "stopped");
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    }).catch(() => {
      wrapped.exit(code || 1);
    });
  });
}

/** The CLI: argv after `pages`. Returns the exit code. */
export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void, deps: () => CliDeps = realCliDeps): Promise<number> {
  const cmd = argv[0];
  const known = ["serve", "ensure", "url", "status", "stop", "rotate"];
  if (!known.includes(cmd) || (cmd === "url" ? argv.length !== 2 : argv.length !== 1)) {
    err(`${USAGE}\n`);
    return 2;
  }
  const d = deps();
  const stateDir = pagesStateDir(d.agentDir);
  if (cmd === "serve") return d.serve();
  if (cmd === "rotate") {
    out(`rotated: ${rotateRoots(stateDir)} page folder links ended\n`);
    return 0;
  }
  if (cmd === "stop") {
    const rec = readServer(stateDir);
    const h = rec ? await d.health(rec) : null;
    if (!h) {
      out("no page server is running\n");
      return 0;
    }
    try {
      d.kill(h.pid);
    } catch (e) {
      err(`stop failed: ${(e as Error).message}\n`);
      return 1;
    }
    out("page server stopped\n");
    return 0;
  }
  if (cmd === "status") {
    const cfg = await d.loadConfig();
    const rec = readServer(stateDir);
    const h = rec ? await d.health(rec) : null;
    const lines = [`config: ${cfg.ok ? (cfg.cfg.enabled ? "enabled" : "disabled") : `unusable (${cfg.why}); the server does not start and links stay file links`}`];
    if (rec && h) {
      lines.push(`server: running, pid ${h.pid}, version ${h.version}, port ${h.port}, bind ${h.bind}`);
      if (rec.port !== rec.configPort) lines.push(`port: configured ${rec.configPort} was taken, listening on ${rec.port}${cfg.ok && cfg.cfg.baseUrl ? "; baseUrl is set, so links stay file links until the configured port is free" : ""}`);
    } else lines.push(rec ? "server: recorded but not answering" : "server: not running");
    lines.push(`roots: ${countRoots(stateDir)}`);
    out(`${lines.join("\n")}\n`);
    return 0;
  }
  const cfg = await d.loadConfig();
  if (!cfg.ok || !cfg.cfg.enabled) {
    err(`pages server off: ${cfg.ok ? "pages.server.enabled is false" : cfg.why}\n`);
    return 1;
  }
  if (cmd === "ensure") {
    const rec = await ensureServer(d.ensureDeps());
    if (!rec) {
      err("page server did not start\n");
      return 1;
    }
    out(`page server running on port ${rec.port}\n`);
    return 0;
  }
  // url <path>
  const file = pageFileOf(argv[1]);
  if (!file) return 1;
  const rec = await ensureServer(d.ensureDeps());
  if (!rec) return 1;
  const id = registerRoot(stateDir, path.dirname(file), "dir", d.now());
  const url = id ? servedUrl(rec, cfg.cfg, id, path.basename(file)) : null;
  if (!url) return 1;
  out(`${url}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
