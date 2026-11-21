// The health proof signs every field a decision uses and the server's local socket end: a relay in front of the real server cannot pass.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ensureServer, httpHealth, pageUrlFor, pagesStateDir, readServer, startPageServer } from "../pageserver.ts";
import type { EnsureDeps, PageServer, ServerRecord } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let agentDir: string;
let port: number;
let kills: number[];
let server: PageServer | null;
let relayed: number;
let closers: Array<() => Promise<void>>;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const lanIp = (): string | null => {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  return null;
};
const startReal = async (bind: string): Promise<ServerRecord> => {
  server = await startPageServer({ agentDir, version: "1.0.0", build: "oldbuild", now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind, baseUrl: "" } }), log: () => undefined, exit: () => undefined, pid: process.pid });
  assert.ok(server);
  const rec = readServer(pagesStateDir(agentDir));
  assert.ok(rec);
  assert.equal(rec.port, port);
  return rec;
};
/** TCP relay on listenHost:listenPort to toHost:toPort. */
const tcpRelay = (listenHost: string, listenPort: number, toHost: string, toPort: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const s = net.createServer((c) => {
      relayed++;
      const u = net.connect(toPort, toHost);
      sockets.add(c).add(u);
      c.pipe(u);
      u.pipe(c);
      c.on("error", () => u.destroy());
      u.on("error", () => c.destroy());
    });
    s.once("error", reject);
    s.listen(listenPort, listenHost, () => {
      closers.push(() => new Promise((r) => { for (const x of sockets) x.destroy(); s.close(() => r()); }));
      resolve();
    });
  });
/** HTTP relay on 127.0.0.1:listenPort to the real server, with the JSON answer rewritten by mutate. */
const httpRelay = (listenPort: number, toHost: string, mutate: (j: Record<string, unknown>) => Record<string, unknown>): Promise<void> =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      http.get({ host: toHost, port, path: req.url, headers: { Host: `127.0.0.1:${port}` }, agent: false }, (up) => {
        let b = "";
        up.on("data", (c) => (b += c));
        up.on("end", () => {
          res.writeHead(up.statusCode ?? 502, { "content-type": "application/json" });
          res.end(up.statusCode === 200 ? JSON.stringify(mutate(JSON.parse(b))) : b);
        });
      }).on("error", () => res.destroy());
    });
    s.listen(listenPort, "127.0.0.1", () => {
      closers.push(() => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }));
      resolve();
    });
  });

const ensureDeps = (over: Partial<EnsureDeps> = {}): EnsureDeps => ({
  agentDir, version: "9.9.9", build: "newbuild", identityMtime: () => Number.MAX_SAFE_INTEGER, now: () => Date.now() + 5_000_000, health: httpHealth,
  spawnServer: () => undefined, kill: (pid) => void kills.push(pid), cache: new Map(), startWaitMs: 300, ...over,
});
const writeRec = (r: ServerRecord): void => fs.writeFileSync(path.join(pagesStateDir(agentDir), "server.json"), JSON.stringify(r));
const noLinkNoKill = async (rec: ServerRecord): Promise<void> => {
  assert.equal(await httpHealth(rec), null);
  writeRec(rec);
  assert.equal(await ensureServer(ensureDeps()), null);
  assert.equal(await pageUrlFor(path.join(tmp, "x.html"), "file", { pages: { server: { enabled: true } } } as never, { agentDir, env: {}, ensure: () => ensureServer(ensureDeps({ cache: new Map() })) }), null);
  assert.deepEqual(kills, []);
};

beforeEach(async () => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-relay-"));
  agentDir = path.join(tmp, "agent");
  port = await freePort();
  kills = [];
  server = null;
  closers = [];
  relayed = 0;
});
afterEach(async () => {
  server?.shutdown(0, "end");
  for (const c of closers) await c();
  rmTestTmp(tmp);
});

test("a relay on 127.0.0.1:<P> in front of a server bound to 0.0.0.0:<P> is unhealthy, nothing is killed, no link", async (t) => {
  const lan = lanIp();
  if (!lan) return t.skip("no non-loopback IPv4 address on this machine");
  const rec = await startReal("0.0.0.0");
  try {
    await tcpRelay("127.0.0.1", port, lan, port);
  } catch (e) {
    return t.skip(`the OS refuses a 127.0.0.1 bind next to the 0.0.0.0 bind on the same port (${(e as Error).message})`);
  }
  // when the OS routes the loopback connect to the wildcard server, the relay sees no connection
  const h = await httpHealth(rec);
  if (relayed === 0) return t.skip("the OS routes 127.0.0.1:<P> to the wildcard listener, so no relay stands in between");
  assert.equal(h, null);
  await noLinkNoKill(rec);
});

test("a relay on another port that server.json points to is unhealthy, no kill even with a newer local build, no link", async () => {
  const rec = await startReal("127.0.0.1");
  const q = await freePort();
  await httpRelay(q, "127.0.0.1", (j) => j);
  await noLinkNoKill({ ...rec, port: q });
  // the relay also rewrites the answered port to the one it listens on
  await noLinkNoKill({ ...rec, port: q });
});

for (const [name, mutate] of [
  ["pid", (q: number) => (j: Record<string, unknown>) => ({ ...j, port: q, pid: 1 })],
  ["port only", (q: number) => (j: Record<string, unknown>) => ({ ...j, port: q })],
  ["bind", (q: number) => (j: Record<string, unknown>) => ({ ...j, port: q, bind: "0.0.0.0" })],
  ["build", (q: number) => (j: Record<string, unknown>) => ({ ...j, port: q, build: "other" })],
  ["version", (q: number) => (j: Record<string, unknown>) => ({ ...j, port: q, version: "0.0.1" })],
  ["local address", (q: number) => (j: Record<string, unknown>) => ({ ...j, port: q, localAddress: "127.0.0.1", localPort: q })],
] as const) {
  test(`a tampered ${name} in an otherwise genuine answer fails`, async () => {
    const rec = await startReal("127.0.0.1");
    const q = await freePort();
    await httpRelay(q, "127.0.0.1", mutate(q));
    // the port is rewritten as well so that only the proof and the socket check can stop it
    await noLinkNoKill({ ...rec, port: q });
  });
}

test("a pid in server.json that differs from the answered pid fails", async () => {
  const rec = await startReal("127.0.0.1");
  assert.equal((await httpHealth(rec))?.pid, process.pid);
  await noLinkNoKill({ ...rec, pid: process.pid + 1 });
});

test("the genuine direct answer verifies over 127.0.0.1 and, bound wildcard, over the LAN address", async (t) => {
  const rec = await startReal("0.0.0.0");
  assert.equal((await httpHealth(rec))?.pid, process.pid);
  const lan = lanIp();
  if (!lan) return t.diagnostic("no LAN address; loopback only");
  const h = await httpHealth({ ...rec, bind: lan });
  assert.equal(h?.pid, process.pid);
});

test("a server bound to 127.0.0.1 answers genuinely over localhost-style loopback", async () => {
  const rec = await startReal("127.0.0.1");
  assert.equal((await httpHealth(rec))?.port, port);
});
