// The client side of the page server (pageserver.ts): ensureServer (start, reuse, restart, lock, cache), registerRoot, rotate, pageUrlFor (enabled, remote rule, URL).
// A fake spawn starts the server in this process on a loopback port; a fake kill ends it.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { ENSURE_CACHE_MS, ROOT_KEEP_MS, compareVersions, countRoots, ensureServer, httpHealth, pageUrlFor, pagesStateDir, readServer, registerRoot, rootsDir, rotateRoots, serverFile, startPageServer } from "../pageserver.ts";
import type { EnsureDeps, PageServer, PagesCfg, ServerRecord } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posix } from "./_platform.ts";

let tmp: string;
let agentDir: string;
let port: number;
let clock: number;
let running: Map<number, PageServer>;
let spawns: number;
let kills: number[];

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const cfgOf = (over: Partial<PagesCfg> = {}): PagesCfg => ({ enabled: true, port, bind: "127.0.0.1", baseUrl: "", ...over });

/** Starts a server in this process under a fake pid. */
async function runServer(pid: number, version: string): Promise<PageServer> {
  const s = await startPageServer({ agentDir, version, now: () => clock, loadConfig: async () => ({ ok: true, cfg: cfgOf() }), log: () => undefined, exit: () => undefined, pid });
  assert.ok(s);
  running.set(pid, s);
  return s;
}

let nextPid = 9000;
function ensureDeps(over: Partial<EnsureDeps> = {}, version = "2.0.0"): EnsureDeps {
  return {
    agentDir,
    version,
    now: () => clock,
    health: httpHealth,
    spawnServer: () => {
      spawns++;
      void runServer(++nextPid, version);
    },
    kill: (pid) => {
      kills.push(pid);
      running.get(pid)?.shutdown(0, "killed");
    },
    cache: new Map(),
    startWaitMs: 3000,
    ...over,
  };
}

const request = (p: number, urlPath: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: p, path: urlPath, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

beforeEach(async () => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-ens-"));
  agentDir = path.join(tmp, "agent");
  port = await freePort();
  clock = 5_000_000;
  running = new Map();
  spawns = 0;
  kills = [];
});
afterEach(() => {
  for (const s of running.values()) s.shutdown(0, "test end");
  rmTestTmp(tmp);
});

test("no server running: ensure starts one and returns its record", async () => {
  const rec = await ensureServer(ensureDeps());
  assert.ok(rec);
  assert.equal(spawns, 1);
  assert.equal(rec.port, port);
  assert.deepEqual(readServer(pagesStateDir(agentDir)), rec);
});

test("two concurrent ensure calls (two processes: two caches) start one server", async () => {
  const [a, b] = await Promise.all([ensureServer(ensureDeps()), ensureServer(ensureDeps())]);
  assert.ok(a && b);
  assert.equal(spawns, 1);
  assert.equal(a.healthKey, b.healthKey);
  assert.equal(a.pid, b.pid);
});

test("calls in one process share the outcome", async () => {
  const deps = ensureDeps();
  const [a, b] = await Promise.all([ensureServer(deps), ensureServer(deps)]);
  assert.equal(a, b);
  assert.equal(spawns, 1);
});

test("a healthy server of an older version is ended by the pid its health answer gives and replaced", async () => {
  await runServer(7001, "1.0.0");
  const rec = await ensureServer(ensureDeps({}, "2.0.0"));
  assert.ok(rec);
  assert.deepEqual(kills, [7001]);
  assert.equal(spawns, 1);
  assert.equal(rec.version, "2.0.0");
  assert.equal(rec.port, port);
});

test("a healthy server of an equal or newer version is reused: no spawn, no kill", async () => {
  await runServer(7002, "3.0.0");
  const rec = await ensureServer(ensureDeps({}, "2.0.0"));
  assert.equal(rec?.pid, 7002);
  const again = await ensureServer(ensureDeps({}, "3.0.0"));
  assert.equal(again?.pid, 7002);
  assert.equal(spawns, 0);
  assert.deepEqual(kills, []);
});

test("an unhealthy record that names a live unrelated pid is never killed; a new server replaces it", async () => {
  fs.mkdirSync(pagesStateDir(agentDir), { recursive: true });
  const dead: ServerRecord = { pid: process.pid, port, configPort: port, bind: "127.0.0.1", version: "1.0.0", startedAt: 1, healthKey: "stale-key" };
  fs.writeFileSync(serverFile(pagesStateDir(agentDir)), JSON.stringify(dead));
  const rec = await ensureServer(ensureDeps());
  assert.ok(rec);
  assert.deepEqual(kills, []);
  assert.equal(spawns, 1);
  assert.notEqual(rec.healthKey, "stale-key");
});

test("another program on the recorded port is not killed either", async () => {
  const foreign = await new Promise<net.Server>((resolve) => {
    const s = net.createServer((c) => c.destroy()).listen(port, "127.0.0.1", () => resolve(s));
  });
  try {
    fs.mkdirSync(pagesStateDir(agentDir), { recursive: true });
    fs.writeFileSync(serverFile(pagesStateDir(agentDir)), JSON.stringify({ pid: process.pid, port, configPort: port, bind: "127.0.0.1", version: "1.0.0", startedAt: 1, healthKey: "k" }));
    const rec = await ensureServer(ensureDeps({ spawnServer: () => { spawns++; } , startWaitMs: 300 }));
    assert.equal(rec, null);
    assert.deepEqual(kills, []);
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test("a failed ensure is cached for 60 s, then tried again", async () => {
  const cache = new Map();
  const deps = ensureDeps({ cache, spawnServer: () => { spawns++; }, startWaitMs: 200 });
  assert.equal(await ensureServer(deps), null);
  assert.equal(await ensureServer(deps), null);
  assert.equal(spawns, 1);
  clock += ENSURE_CACHE_MS - 1;
  assert.equal(await ensureServer(deps), null);
  assert.equal(spawns, 1);
  clock += 2;
  assert.equal(await ensureServer(deps), null);
  assert.equal(spawns, 2);
});

test("compareVersions orders numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0.0-rc1", "2.0.0"), 0);
});

// ------------------------------------------------------------ roots

test("registerRoot reuses the same real path, touches it, and keeps the id; records are mode 0600", () => {
  const state = pagesStateDir(agentDir);
  const dir = path.join(tmp, "pages");
  fs.mkdirSync(dir);
  const a = registerRoot(state, dir, "dir", 1000);
  const b = registerRoot(state, dir, "dir", 2000);
  assert.ok(a);
  assert.equal(a, b);
  assert.match(a, /^[a-z2-7]{26}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootsDir(state), `${a}.json`), "utf8")).touchedAt, 2000);
  assert.equal(countRoots(state), 1);
  if (posix) assert.equal(fs.statSync(path.join(rootsDir(state), `${a}.json`)).mode & 0o777, 0o600);
  const other = path.join(tmp, "pages2");
  fs.mkdirSync(other);
  assert.notEqual(registerRoot(state, other, "dir", 3000), a);
  assert.equal(countRoots(state), 2);
});

test("registerRoot refuses a missing path and a kind mismatch", () => {
  const state = pagesStateDir(agentDir);
  fs.writeFileSync(path.join(tmp, "f.md"), "x");
  assert.equal(registerRoot(state, path.join(tmp, "nope"), "dir"), null);
  assert.equal(registerRoot(state, path.join(tmp, "f.md"), "dir"), null);
  assert.equal(registerRoot(state, tmp, "file"), null);
});

test("roots untouched for 7 days are pruned at the next registration", () => {
  const state = pagesStateDir(agentDir);
  const old = path.join(tmp, "old");
  const fresh = path.join(tmp, "fresh");
  fs.mkdirSync(old);
  fs.mkdirSync(fresh);
  const oldId = registerRoot(state, old, "dir", 1000);
  registerRoot(state, fresh, "dir", 1001 + ROOT_KEEP_MS);
  assert.ok(oldId);
  assert.equal(fs.existsSync(path.join(rootsDir(state), `${oldId}.json`)), false);
  assert.equal(countRoots(state), 1);
});

test("rotate deletes every root record: old links give 404, a new registration gets a new id", async () => {
  const s = await runServer(7100, "2.0.0");
  const state = pagesStateDir(agentDir);
  const dir = path.join(tmp, "ws", "show", "sid", "pages");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.html"), "page");
  const id = registerRoot(state, dir, "dir");
  assert.ok(id);
  assert.equal((await request(s.port, `/${id}/plan.html`)).status, 200);
  assert.equal(rotateRoots(state), 1);
  assert.equal((await request(s.port, `/${id}/plan.html`)).status, 404);
  const next = registerRoot(state, dir, "dir");
  assert.ok(next && next !== id);
  assert.equal((await request(s.port, `/${next}/plan.html`)).status, 200);
});

// ------------------------------------------------------------ pageUrlFor

const urlDeps = (env: NodeJS.ProcessEnv = {}, over: Record<string, unknown> = {}) => ({ env, agentDir, now: () => clock, ensure: () => ensureServer(ensureDeps()), ...over });

test("pageUrlFor: a page of a pages/ folder gets a served URL that serves the page", async () => {
  const dir = path.join(tmp, "ws", "show", "sid", "pages");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.html"), "<p>served</p>");
  const url = await pageUrlFor(path.join(dir, "plan.html"), "dir", undefined, urlDeps());
  assert.ok(url);
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/[a-z2-7]{26}/plan\\.html$`));
  const r = await request(port, new URL(url).pathname);
  assert.deepEqual(r, { status: 200, body: "<p>served</p>" });
  assert.equal(await pageUrlFor(path.join(dir, "plan.html"), "dir", undefined, urlDeps()), url);
});

test("pageUrlFor: a brief file is its own root", async () => {
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, "# Brief\n\nhello\n");
  const url = await pageUrlFor(f, "file", undefined, urlDeps());
  assert.ok(url?.endsWith("/brief.md"));
  const r = await request(port, new URL(url as string).pathname);
  assert.equal(r.status, 200);
  assert.match(r.body, /<h1>Brief<\/h1>/);
});

test("pageUrlFor: enabled false gives null and does not call ensure", async () => {
  let called = 0;
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, "x");
  const url = await pageUrlFor(f, "file", { pages: { server: { enabled: false } } }, urlDeps({}, { ensure: async () => { called++; return null; } }));
  assert.equal(url, null);
  assert.equal(called, 0);
});

test("pageUrlFor: a remote session keeps file links unless its own baseUrl is set", async () => {
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, "x");
  for (const env of [{ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, { PI_FOREMAN_REMOTE_PARENT: "1" }]) {
    assert.equal(await pageUrlFor(f, "file", undefined, urlDeps(env)), null, JSON.stringify(env));
    const url = await pageUrlFor(f, "file", { pages: { server: { baseUrl: "https://box.example" } } }, urlDeps(env));
    assert.match(url ?? "", /^https:\/\/box\.example\/[a-z2-7]{26}\/brief\.md$/, JSON.stringify(env));
  }
  assert.match((await pageUrlFor(f, "file", undefined, urlDeps({ PI_FOREMAN_REMOTE_PARENT: "0" }))) ?? "", /^http:/);
});

test("pageUrlFor: baseUrl set while the server fell back to a free port gives null", async () => {
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, "x");
  const foreign = await new Promise<net.Server>((resolve) => {
    const s = net.createServer((c) => c.destroy()).listen(port, "127.0.0.1", () => resolve(s));
  });
  try {
    const rec = await ensureServer(ensureDeps());
    assert.ok(rec && rec.port !== port);
    assert.equal(await pageUrlFor(f, "file", { pages: { server: { baseUrl: "https://box.example" } } }, urlDeps()), null);
    assert.match((await pageUrlFor(f, "file", undefined, urlDeps())) ?? "", new RegExp(`^http://127\\.0\\.0\\.1:${rec.port}/`));
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test("pageUrlFor: a server that cannot start gives null (file link)", async () => {
  const f = path.join(tmp, "brief.md");
  fs.writeFileSync(f, "x");
  const url = await pageUrlFor(f, "file", undefined, urlDeps({}, { ensure: () => ensureServer(ensureDeps({ spawnServer: () => undefined, startWaitMs: 100 })) }));
  assert.equal(url, null);
});
