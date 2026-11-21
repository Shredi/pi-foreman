// A wildcard bind with an empty baseUrl gives no served link; with baseUrl set the baseUrl link is made.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ensureServer, httpHealth, pageUrlFor, pagesStateDir, readServer, startPageServer } from "../pageserver.ts";
import type { EnsureDeps, PageServer } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let agentDir: string;
let server: PageServer | null;

const freePort = (host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once("error", reject).listen(0, host, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const start = async (bind: string, port: number, baseUrl: string): Promise<void> => {
  server = await startPageServer({ agentDir, version: "1.0.0", build: "b", now: Date.now, loadConfig: async () => ({ ok: true, cfg: { enabled: true, port, bind, baseUrl } }), log: () => undefined, exit: () => undefined, pid: process.pid });
  assert.ok(server);
  assert.ok(readServer(pagesStateDir(agentDir)));
};
const ensureDeps = (): EnsureDeps => ({ agentDir, version: "1.0.0", build: "b", now: Date.now, health: httpHealth, spawnServer: () => undefined, kill: () => undefined, cache: new Map(), startWaitMs: 300 });
const link = (file: string, baseUrl: string): Promise<string | null> => pageUrlFor(file, "file", { pages: { server: { enabled: true, baseUrl } } } as never, { agentDir, env: {}, ensure: () => ensureServer(ensureDeps()) });

beforeEach(() => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-wild-"));
  agentDir = path.join(tmp, "agent");
  server = null;
});
afterEach(() => {
  server?.shutdown(0, "end");
  rmTestTmp(tmp);
});

const brief = (): string => {
  const f = path.join(tmp, "b.md");
  fs.writeFileSync(f, "x");
  return f;
};

for (const bind of ["0.0.0.0", "::"]) {
  test(`bind ${bind} with empty baseUrl gives no served link`, async (t) => {
    let port: number;
    try {
      port = await freePort(bind);
    } catch {
      return t.skip(`cannot listen on ${bind}`);
    }
    await start(bind, port, "");
    assert.equal(await link(brief(), ""), null);
  });

  test(`bind ${bind} with baseUrl gives the baseUrl link`, async (t) => {
    let port: number;
    try {
      port = await freePort(bind);
    } catch {
      return t.skip(`cannot listen on ${bind}`);
    }
    await start(bind, port, "https://pages.example");
    assert.match((await link(brief(), "https://pages.example")) ?? "", /^https:\/\/pages\.example\/[a-z2-7]{26}\/b\.md$/);
  });
}
