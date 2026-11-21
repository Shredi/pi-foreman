// Server identity (pageserver.ts): the build hash over the server's source files and the restart rule of ensureServer (build differs AND own files newer than the server's start).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { buildIdentity, ensureServer, httpHealth, identityFiles, pagesStateDir, readServer, startPageServer } from "../pageserver.ts";
import type { EnsureDeps, PageServer } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let agentDir: string;
let port: number;
let running: Map<number, PageServer>;
let spawns: number;
let kills: number[];
let nextPid = 9500;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

beforeEach(async () => {
  tmp = mkTestTmp("pageserver-identity");
  agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  port = await freePort();
  running = new Map();
  spawns = 0;
  kills = [];
});
afterEach(() => {
  for (const s of running.values()) s.shutdown(0, "test");
  rmTestTmp(tmp);
});

async function runServer(pid: number, build: string): Promise<PageServer> {
  const s = await startPageServer({ agentDir, version: "1.0.0", build, now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind: "127.0.0.1", baseUrl: "" } }), log: () => undefined, exit: () => undefined, pid });
  assert.ok(s);
  running.set(pid, s);
  return s;
}

const deps = (build: string, mtime: number): EnsureDeps => ({
  agentDir,
  version: "1.0.0",
  build,
  identityMtime: () => mtime,
  now: Date.now,
  health: httpHealth,
  spawnServer: () => {
    spawns++;
    void runServer(++nextPid, build);
  },
  kill: (pid) => {
    kills.push(pid);
    running.get(pid)?.shutdown(0, "killed");
  },
  cache: new Map(),
  startWaitMs: 3000,
});

test("build identity is stable, 16 hex, and covers the rendering modules", () => {
  const a = buildIdentity();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(buildIdentity(), a);
  const names = identityFiles().map((f) => path.basename(f));
  for (const n of ["pageserver.ts", "pages-cli.ts", "pages.ts", "htmlmd.ts", "mermaid.ts"]) assert.ok(names.includes(n), n);
});

test("build identity changes with a byte of a file and ignores unrelated files", () => {
  fs.writeFileSync(path.join(tmp, "pageserver.ts"), 'import { x } from "./a.ts";\n');
  fs.writeFileSync(path.join(tmp, "pages-cli.ts"), "export {};\n");
  fs.writeFileSync(path.join(tmp, "a.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(tmp, "other.ts"), "1\n");
  const b1 = buildIdentity(tmp);
  fs.writeFileSync(path.join(tmp, "other.ts"), "2\n");
  assert.equal(buildIdentity(tmp), b1);
  fs.writeFileSync(path.join(tmp, "a.ts"), "export const x = 2;\n");
  assert.notEqual(buildIdentity(tmp), b1);
});

test("server.json and the health answer carry the build", async () => {
  await runServer(7101, "bbb");
  assert.equal(readServer(pagesStateDir(agentDir))?.build, "bbb");
  const rec = readServer(pagesStateDir(agentDir));
  assert.ok(rec);
  assert.equal((await httpHealth(rec))?.build, "bbb");
});

test("a different build is replaced when the own files are newer than the server's start", async () => {
  await runServer(7102, "old");
  const rec = await ensureServer(deps("new", Date.now() + 60_000));
  assert.deepEqual(kills, [7102]);
  assert.equal(spawns, 1);
  assert.equal(rec?.build, "new");
});

test("a different build is kept when the own files are older than the server's start (no flip-flop)", async () => {
  await runServer(7103, "newer");
  const rec = await ensureServer(deps("older", Date.now() - 60_000));
  assert.equal(rec?.pid, 7103);
  assert.deepEqual(kills, []);
  assert.equal(spawns, 0);
});

test("the same build is reused whatever the mtime", async () => {
  await runServer(7104, "same");
  const rec = await ensureServer(deps("same", Date.now() + 60_000));
  assert.equal(rec?.pid, 7104);
  assert.deepEqual(kills, []);
  assert.equal(spawns, 0);
});

test("a server without a build (older install) counts as a different build", async () => {
  const s = await startPageServer({ agentDir, version: "1.0.0", now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind: "127.0.0.1", baseUrl: "" } }), log: () => undefined, exit: () => undefined, pid: 7105 });
  assert.ok(s);
  running.set(7105, s);
  await ensureServer(deps("new", Date.now() + 60_000));
  assert.deepEqual(kills, [7105]);
});
