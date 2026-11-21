// pageServerDoctorLine: the /foreman doctor lines for the page server.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pageServerDoctorLine, pagesStateDir, serverFile } from "../pageserver.ts";
import type { Health, ServerRecord } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkTestTmp("pageserver-doctor");
});
afterEach(() => rmTestTmp(tmp));

const cfgOf = (server: Record<string, unknown>) => ({ pages: { server } });
const write = (over: Partial<ServerRecord> = {}): ServerRecord => {
  const rec: ServerRecord = { pid: 5, port: 47317, configPort: 47317, bind: "127.0.0.1", version: "1", startedAt: 1, healthKey: "SECRETKEY", ...over };
  fs.mkdirSync(pagesStateDir(tmp), { recursive: true });
  fs.writeFileSync(serverFile(pagesStateDir(tmp)), JSON.stringify(rec));
  return rec;
};
const up = async (r: ServerRecord): Promise<Health | null> => ({ pid: r.pid, version: "1", port: r.port, bind: r.bind });
const down = async (): Promise<Health | null> => null;

test("off", async () => {
  assert.equal(await pageServerDoctorLine(cfgOf({ enabled: false }), tmp, up), "INFO page server is off (pages.server.enabled)");
});

test("not running: no record, or a record that does not answer", async () => {
  assert.equal(await pageServerDoctorLine(cfgOf({ enabled: true }), tmp, up), "INFO page server not running (starts on first link)");
  write();
  assert.equal(await pageServerDoctorLine(cfgOf({ enabled: true }), tmp, down), "INFO page server not running (starts on first link)");
});

test("running", async () => {
  write();
  assert.equal(await pageServerDoctorLine(cfgOf({ enabled: true }), tmp, up), "OK   page server: running on 127.0.0.1:47317");
});

test("baseUrl set and another port taken", async () => {
  write({ port: 50000 });
  const line = await pageServerDoctorLine(cfgOf({ enabled: true, baseUrl: "http://h.example:47317" }), tmp, up);
  assert.equal(line, "WARN page server: baseUrl set but the server listens on port 50000, not 47317; links fall back to files — fix: free port 47317 or change pages.server.port");
});

test("non-loopback bind with an empty baseUrl; with a baseUrl it is fine", async () => {
  write({ bind: "100.64.0.5" });
  assert.equal(await pageServerDoctorLine(cfgOf({ enabled: true }), tmp, up), "WARN page server: bind 100.64.0.5 is not loopback and baseUrl is empty; links fall back to files");
  assert.match(await pageServerDoctorLine(cfgOf({ enabled: true, baseUrl: "http://h.example:47317" }), tmp, up), /^OK/);
});

test("no line names the health key", async () => {
  write({ port: 50000 });
  for (const c of [cfgOf({ enabled: true }), cfgOf({ enabled: true, baseUrl: "http://h.example" })]) assert.doesNotMatch(await pageServerDoctorLine(c, tmp, up), /SECRETKEY/);
  assert.ok(path.isAbsolute(tmp));
});
