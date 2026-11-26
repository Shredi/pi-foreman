// A changed pages.server.baseUrl reaches the next page link without a restart: links read the pages config through a ReloadingConfig, not the session snapshot.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ReloadingConfig } from "../openprs.ts";
import { pageUrlFor } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let agentDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-reload-"));
  agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ baseUrl: "https://one.example" }));
});
afterEach(() => rmTestTmp(tmp));

test("the next link after a baseUrl change uses the new base; the snapshot would keep the old one", async () => {
  const load = async () => ({ config: { pages: { server: { enabled: true, baseUrl: JSON.parse(fs.readFileSync(path.join(agentDir, "foreman.json"), "utf8")).baseUrl } } } });
  const snapshot = await load();
  const reader = new ReloadingConfig(agentDir, snapshot, load);
  const rec = { port: 1, configPort: 1, bind: "127.0.0.1" } as never;
  const page = path.join(tmp, "b.md");
  fs.writeFileSync(page, "x");
  const link = async (): Promise<string | null> => {
    await reader.refresh();
    return pageUrlFor(page, "file", reader.current().config as never, { agentDir, env: {}, ensure: async () => rec });
  };
  assert.match((await link()) ?? "", /^https:\/\/one\.example\//);
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ baseUrl: "https://two.example/x" }));
  assert.match((await link()) ?? "", /^https:\/\/two\.example\/x\//);
  assert.match((await pageUrlFor(page, "file", snapshot.config as never, { agentDir, env: {}, ensure: async () => rec })) ?? "", /^https:\/\/one\.example\//);
});

test("the session's page-link call sites read the reloading config, not s.config.config", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
  const calls = src.split("\n").filter((l) => l.includes("pageLinks.url("));
  assert.equal(calls.length, 2);
  for (const l of calls) assert.match(l, /pagesConfigOf\(s\)/);
});
