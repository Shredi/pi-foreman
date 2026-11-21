// The health answer is authenticated by challenge-response: an impostor on the recorded port is unhealthy, the key never leaves the client.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { main } from "../pages-cli.ts";
import type { CliDeps } from "../pages-cli.ts";
import { ensureServer, healthProof, httpHealth, pageUrlFor, pagesStateDir, readServer, serverFile, startPageServer } from "../pageserver.ts";
import type { EnsureDeps, PageServer, ServerRecord } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let agentDir: string;
let port: number;
let seen: string[];
let impostor: http.Server | null;
let kills: number[];
let servers: PageServer[];

const KEY = "SECRET-HEALTH-KEY-0123456789";
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const recOf = (over: Partial<ServerRecord> = {}): ServerRecord => ({ pid: process.pid, port, configPort: port, bind: "127.0.0.1", version: "1.0.0", startedAt: 1, healthKey: KEY, ...over });
const writeRec = (r: ServerRecord): void => {
  fs.mkdirSync(pagesStateDir(agentDir), { recursive: true });
  fs.writeFileSync(serverFile(pagesStateDir(agentDir)), JSON.stringify(r));
};
const impostorOn = (answer: (nonce: string) => Record<string, unknown>): Promise<void> =>
  new Promise((resolve) => {
    impostor = http.createServer((req, res) => {
      seen.push(`${req.url ?? ""} ${JSON.stringify(req.headers)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(String(req.url).split("/").pop() ?? "")));
    }).listen(port, "127.0.0.1", () => resolve());
  });
const well = { pid: process.pid, version: "0.0.1", port: 0, bind: "127.0.0.1" };
const ensureDeps = (over: Partial<EnsureDeps> = {}): EnsureDeps => ({
  agentDir, version: "9.9.9", build: "newbuild", identityMtime: () => Number.MAX_SAFE_INTEGER, now: () => 5_000_000, health: httpHealth,
  spawnServer: () => undefined, kill: (pid) => void kills.push(pid), cache: new Map(), startWaitMs: 300, ...over,
});

beforeEach(async () => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-hauth-"));
  agentDir = path.join(tmp, "agent");
  port = await freePort();
  seen = [];
  kills = [];
  servers = [];
  impostor = null;
});
afterEach(async () => {
  for (const s of servers) s.shutdown(0, "end");
  if (impostor) await new Promise((r) => impostor?.close(r));
  rmTestTmp(tmp);
});

for (const [name, answer] of [
  ["without a proof", () => ({ ...well, port })],
  ["with a fake proof", () => ({ ...well, port, proof: "00".repeat(32) })],
  ["with the key as proof", () => ({ ...well, port, proof: KEY })],
] as const) {
  test(`an impostor answering well-formed JSON ${name} is unhealthy and nothing follows from it`, async () => {
    await impostorOn(answer);
    const rec = recOf();
    writeRec(rec);
    assert.equal(await httpHealth(rec), null);
    const got = await ensureServer(ensureDeps());
    assert.equal(got, null);
    assert.deepEqual(kills, []);
    assert.equal(await pageUrlFor(path.join(tmp, "x.html"), "file", { pages: { server: { enabled: true } } } as never, { agentDir, env: {}, ensure: () => ensureServer(ensureDeps({ cache: new Map() })) }), null);
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((s) => !s.includes(KEY)));
  });
}

test("`pages stop` and status against an impostor kill nothing", async () => {
  await impostorOn(() => ({ ...well, port, proof: "ab" }));
  writeRec(recOf());
  const deps = (): CliDeps => ({ agentDir, pkgRoot: tmp, now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind: "127.0.0.1", baseUrl: "" } as never }), ensureDeps: () => ensureDeps(), health: httpHealth, kill: (pid) => void kills.push(pid), serve: async () => 0 });
  let out = "";
  assert.equal(await main(["stop"], (s) => (out += s), () => undefined, deps), 0);
  assert.match(out, /no page server is running/);
  out = "";
  await main(["status"], (s) => (out += s), () => undefined, deps);
  assert.match(out, /recorded but not answering/);
  assert.deepEqual(kills, []);
  assert.ok(seen.every((s) => !s.includes(KEY)));
});

test("the real server's answer verifies, a replayed proof for another nonce does not", async () => {
  const s = await startPageServer({ agentDir, version: "1.0.0", now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind: "127.0.0.1", baseUrl: "" } }), log: () => undefined, exit: () => undefined, pid: process.pid });
  assert.ok(s);
  servers.push(s);
  const rec = readServer(pagesStateDir(agentDir));
  assert.ok(rec);
  assert.equal((await httpHealth(rec))?.pid, process.pid);
  const ask = (nonce: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `/_health/${nonce}`, agent: false }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(JSON.parse(b)));
      }).on("error", reject);
    });
  const n1 = "a".repeat(32);
  const n2 = "b".repeat(32);
  const a1 = await ask(n1);
  assert.equal(a1.proof, healthProof(rec.healthKey, n1, { pid: a1.pid as number, port: a1.port as number, bind: a1.bind as string, version: a1.version as string, ...(typeof a1.build === "string" ? { build: a1.build } : {}) }, { address: a1.localAddress as string, port: a1.localPort as number }));
  assert.notEqual((await ask(n2)).proof, a1.proof);
  assert.ok(!JSON.stringify(a1).includes(rec.healthKey));
  // an impostor replaying the proof recorded for n1 fails against a fresh nonce
  s.shutdown(0, "swap");
  await new Promise((r) => setTimeout(r, 50));
  await impostorOn(() => ({ ...well, port, proof: a1.proof }));
  assert.equal(await httpHealth(rec), null);
});

test("a server exits on recheck when server.json names another pid", async () => {
  const exits: number[] = [];
  const s = await startPageServer({ agentDir, version: "1.0.0", now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind: "127.0.0.1", baseUrl: "" } }), log: () => undefined, exit: (c) => void exits.push(c), pid: 4242 });
  assert.ok(s);
  servers.push(s);
  await s.recheck();
  assert.equal(s.closed(), false);
  writeRec({ ...s.record, pid: 4243 });
  await s.recheck();
  assert.equal(s.closed(), true);
  assert.deepEqual(exits, [0]);
});
