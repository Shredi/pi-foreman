// The link base is the local end the health check connected to and verified, never a host re-derived from the bind.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as dns from "node:dns/promises";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { ensureServer, httpHealth, pageUrlFor, pagesStateDir, readServer, startPageServer } from "../pageserver.ts";
import type { EnsureDeps, PageServer } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let agentDir: string;
let port: number;
let server: PageServer | null;
let closers: Array<() => Promise<void>>;
let seen: string[];

const freePort = (host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once("error", reject).listen(0, host, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const start = async (bind: string): Promise<void> => {
  server = await startPageServer({ agentDir, version: "1.0.0", build: "b", now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind, baseUrl: "" } }), log: () => undefined, exit: () => undefined, pid: process.pid });
  assert.ok(server);
  assert.ok(readServer(pagesStateDir(agentDir)));
};
const ensureDeps = (): EnsureDeps => ({ agentDir, version: "1.0.0", build: "b", now: Date.now, health: httpHealth, spawnServer: () => undefined, kill: () => undefined, cache: new Map(), startWaitMs: 300 });
const link = (file: string): Promise<string | null> => pageUrlFor(file, "file", { pages: { server: { enabled: true } } } as never, { agentDir, env: {}, ensure: () => ensureServer(ensureDeps()) });
const impostor = (p: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(404).end();
    });
    s.once("error", reject);
    s.listen(p, "127.0.0.1", () => {
      closers.push(() => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }));
      resolve();
    });
  });

beforeEach(async () => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-linkhost-"));
  agentDir = path.join(tmp, "agent");
  server = null;
  closers = [];
  seen = [];
});
// idempotent: t.skip() inside a test body skips afterEach on Node 22, so a test that skips after start() calls it itself first
const teardown = async (): Promise<void> => {
  server?.shutdown(0, "end");
  server = null;
  const cs = closers;
  closers = [];
  for (const c of cs) await c();
};
afterEach(async () => {
  await teardown();
  rmTestTmp(tmp);
});

const brief = (): string => {
  const f = path.join(tmp, "b.md");
  fs.writeFileSync(f, "x");
  return f;
};

test("bind ::1 gives an http://[::1]:P link, and a listener on 127.0.0.1:P receives no request", async (t) => {
  try {
    port = await freePort("::1");
  } catch {
    return t.skip("no IPv6 loopback");
  }
  await start("::1");
  try {
    await impostor(port);
  } catch (e) {
    await teardown();
    return t.skip(`cannot listen on 127.0.0.1:${port} (${(e as Error).message})`);
  }
  const url = await link(brief());
  assert.match(url ?? "", new RegExp(`^http://\\[::1\\]:${port}/[a-z2-7]{26}/b\\.md$`));
  assert.deepEqual(seen, []);
});

test("bind localhost links the address the check verified, never 127.0.0.1 when the server is on ::1", async (t) => {
  const addr = (await dns.lookup("localhost")).address;
  try {
    port = await freePort(addr);
  } catch {
    return t.skip(`cannot listen on ${addr}`);
  }
  await start("localhost");
  if (addr === "::1") {
    try {
      await impostor(port);
    } catch (e) {
      await teardown();
      return t.skip(`cannot listen on 127.0.0.1:${port} (${(e as Error).message})`);
    }
  }
  const url = await link(brief());
  const host = addr === "::1" ? "\\[::1\\]" : "127\\.0\\.0\\.1";
  assert.match(url ?? "", new RegExp(`^http://${host}:${port}/[a-z2-7]{26}/b\\.md$`));
  assert.deepEqual(seen, []);
});

test("bind 127.0.0.1 is unchanged", async () => {
  port = await freePort("127.0.0.1");
  await start("127.0.0.1");
  assert.match((await link(brief())) ?? "", new RegExp(`^http://127\\.0\\.0\\.1:${port}/[a-z2-7]{26}/b\\.md$`));
});
