// `foreman pages` (pages-cli.ts): usage, `url` refusals and success, `status` without secrets, `stop` (health-checked), `rotate`, `ensure` and `url` when the server is off.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { main, pageFileOf } from "../pages-cli.ts";
import type { CliDeps } from "../pages-cli.ts";
import { countRoots, ensureServer, httpHealth, pagesStateDir, readServer, registerRoot, serverFile, startPageServer } from "../pageserver.ts";
import type { CfgResult, PageServer } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

let tmp: string;
let agentDir: string;
let port: number;
let cfg: CfgResult;
let servers: PageServer[];
let killed: number[];
let served: number;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const okCfg = (over: Record<string, unknown> = {}): CfgResult => ({ ok: true, cfg: { enabled: true, port, bind: "127.0.0.1", baseUrl: "", ...over } as never });

const deps = (): CliDeps => ({
  agentDir,
  pkgRoot: tmp,
  now: Date.now,
  loadConfig: async () => cfg,
  ensureDeps: () => ({
    agentDir,
    version: "1.0.0",
    now: Date.now,
    health: httpHealth,
    spawnServer: () => {
      void startPageServer({ agentDir, version: "1.0.0", now: Date.now, loadConfig: async () => cfg, log: () => undefined, exit: () => undefined, pid: 8000 + served++ }).then((s) => s && servers.push(s));
    },
    kill: () => undefined,
    cache: new Map(),
  }),
  health: httpHealth,
  kill: (pid) => {
    killed.push(pid);
    for (const s of servers) if (s.record.pid === pid) s.shutdown(0, "stop");
  },
  serve: async () => 0,
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, (s) => (out += s), (s) => (err += s), deps);
  return { code, out, err };
}

function showPage(name = "plan.html", id = "sid"): string {
  const dir = path.join(tmp, "ws", ".workflow", "scratch", "show", id, "pages");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, "<p>x</p>");
  return f;
}

beforeEach(async () => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-cli-"));
  agentDir = path.join(tmp, "agent");
  port = await freePort();
  cfg = okCfg();
  servers = [];
  killed = [];
  served = 0;
});
afterEach(() => {
  for (const s of servers) s.shutdown(0, "end");
  rmTestTmp(tmp);
});

test("usage: an unknown command, no command or a wrong argument count exits 2", async () => {
  for (const argv of [[], ["nope"], ["url"], ["url", "a", "b"], ["status", "x"], ["serve", "x"]]) {
    const r = await run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /usage: foreman pages/);
  }
});

test("url prints the served URL of a page file of a show pages/ folder", async () => {
  const f = showPage("note-12.html", "abc.DEF-1");
  const r = await run(["url", f]);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`^http://127\\.0\\.0\\.1:${port}/[A-Za-z0-9_-]{43}/note-12\\.html\\n$`));
  assert.equal(r.err, "");
  for (const name of ["plan.html", "result.html"]) assert.equal((await run(["url", showPage(name)])).code, 0, name);
});

test("url refuses a path outside a show pages/ folder, a non-page name and an .md brief: nothing printed, exit 1", async () => {
  const brief = path.join(tmp, "brief.md");
  fs.writeFileSync(brief, "# b");
  const stray = path.join(tmp, "plan.html");
  fs.writeFileSync(stray, "x");
  const noShow = path.join(tmp, "ws", "pages", "plan.html");
  fs.mkdirSync(path.dirname(noShow), { recursive: true });
  fs.writeFileSync(noShow, "x");
  const wrongName = showPage("index.html");
  const notPageFile = showPage("plan.md");
  const badId = showPage("plan.html", "id with space");
  const dir = path.dirname(showPage());
  for (const p of [brief, stray, noShow, wrongName, notPageFile, badId, dir, "relative/plan.html", path.join(tmp, "missing.html"), showPage("note-1234567.html"), showPage("pages.json")]) {
    const r = await run(["url", p]);
    assert.equal(r.code, 1, p);
    assert.equal(r.out, "", p);
  }
  assert.equal(countRoots(pagesStateDir(agentDir)), 0);
});

test("url refuses a symlink to a page and a hard-linked page", { skip: posixOnly }, async () => {
  const real = showPage("plan.html", "real");
  const dir = path.dirname(showPage("plan.html", "other"));
  fs.rmSync(path.join(dir, "plan.html"));
  fs.symlinkSync(real, path.join(dir, "plan.html"));
  assert.equal((await run(["url", path.join(dir, "plan.html")])).code, 1);
  const dir3 = path.dirname(showPage("plan.html", "third"));
  fs.rmSync(path.join(dir3, "plan.html"));
  fs.linkSync(real, path.join(dir3, "plan.html"));
  assert.equal((await run(["url", path.join(dir3, "plan.html")])).code, 1);
  assert.equal((await run(["url", real])).code, 1, "the original now has two links");
  assert.equal(pageFileOf(path.join(dir3, "plan.html")), null);
});

test("url, with the server off or the config unusable: nothing printed, exit 1", async () => {
  const f = showPage();
  cfg = okCfg({ enabled: false });
  assert.deepEqual({ ...(await run(["url", f])), err: "" }, { code: 1, out: "", err: "" });
  cfg = { ok: false, why: "config error: x" };
  const r = await run(["url", f]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.equal(servers.length, 0);
});

test("ensure starts the server; with the server off it exits 1", async () => {
  const r = await run(["ensure"]);
  assert.equal(r.code, 0);
  assert.equal(servers.length, 1);
  cfg = okCfg({ enabled: false });
  assert.equal((await run(["ensure"])).code, 1);
});

test("status shows the state and never a secret", async () => {
  const f = showPage();
  const url = (await run(["url", f])).out.trim();
  const id = new URL(url).pathname.split("/")[1];
  const rec = readServer(pagesStateDir(agentDir));
  assert.ok(rec);
  const r = await run(["status"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /server: running, pid \d+, version 1\.0\.0, port \d+, bind 127\.0\.0\.1/);
  assert.match(r.out, /roots: 1/);
  assert.ok(!r.out.includes(id));
  assert.ok(!r.out.includes(rec.healthKey));
});

test("status names a fallback port and the baseUrl consequence", async () => {
  const foreign = await new Promise<net.Server>((resolve) => {
    const s = net.createServer((c) => c.destroy()).listen(port, "127.0.0.1", () => resolve(s));
  });
  try {
    cfg = okCfg({ baseUrl: "https://box.example" });
    assert.ok(await ensureServer(deps().ensureDeps()));
    const r = await run(["status"]);
    assert.match(r.out, /configured \d+ was taken/);
    assert.match(r.out, /baseUrl is set, so links stay file links/);
  } finally {
    await new Promise((x) => foreign.close(x));
  }
});

test("stop ends a healthy server by its health answer; with none running it says so; a dead record is not signalled", async () => {
  assert.match((await run(["stop"])).out, /no page server is running/);
  await run(["ensure"]);
  const pid = readServer(pagesStateDir(agentDir))?.pid;
  const r = await run(["stop"]);
  assert.equal(r.code, 0);
  assert.deepEqual(killed, [pid]);
  killed.length = 0;
  assert.match((await run(["stop"])).out, /no page server is running/);
  fs.writeFileSync(serverFile(pagesStateDir(agentDir)), JSON.stringify({ pid: process.pid, port, configPort: port, bind: "127.0.0.1", version: "1", startedAt: 1, healthKey: "k" }));
  assert.match((await run(["stop"])).out, /no page server is running/);
  assert.deepEqual(killed, []);
});

test("rotate deletes every root record", async () => {
  const state = pagesStateDir(agentDir);
  const d1 = path.join(tmp, "a");
  const d2 = path.join(tmp, "b");
  fs.mkdirSync(d1);
  fs.mkdirSync(d2);
  registerRoot(state, d1, "dir");
  registerRoot(state, d2, "dir");
  const r = await run(["rotate"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /2 page folder links ended/);
  assert.equal(countRoots(state), 0);
});
