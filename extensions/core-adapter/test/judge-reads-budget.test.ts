// The judge's folder listings share the read budget; names and headers are masked; more deny names (judgereads.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { judgeReadScope, readPaths } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-b-")));
const home = path.join(tmp, "home");
const agent = path.join(home, ".pi", "agent");
const wt = path.join(home, "proj");
for (const d of [agent, wt]) fs.mkdirSync(d, { recursive: true });
const put = (p: string, text = "x\n"): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const S = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, home, config: {} }) as JudgeReadScope;
const TOKEN = "ghp_abcdefghijklmnop1234567890ABCD";

const big = path.join(wt, "big");
for (let i = 0; i < 150; i++) put(path.join(big, `file-${String(i).padStart(3, "0")}-${"n".repeat(40)}.txt`));

test("listing counts against the budget", () => {
  const budget = { left: 10000 };
  const r = readPaths(["big/"], S, budget);
  assert.equal(r.records[0].outcome, "dir");
  assert.equal(budget.left, 10000 - r.blocks[0].body.length);
  assert.ok(budget.left < 10000);
});

test("listing after the budget is spent gets the budget block", () => {
  const budget = { left: 0 };
  const r = readPaths(["big/"], S, budget);
  assert.equal(r.records[0].outcome, "budget");
  assert.equal(r.blocks[0].body, "not read: read budget used up");
});

test("listing is cut to the remaining budget", () => {
  const budget = { left: 500 };
  const r = readPaths(["big/"], S, budget);
  assert.equal(r.records[0].outcome, "dir");
  assert.ok(r.blocks[0].body.length <= 500);
  assert.ok(r.blocks[0].body.endsWith("[cut]"));
  assert.ok(budget.left >= 0);
  const tiny = { left: 3 };
  assert.equal(readPaths(["big/"], S, tiny).records[0].outcome, "budget");
});

test("eight listings stay within the budget", () => {
  const budget = { left: 64 * 1024 };
  const r = readPaths(Array(8).fill("big/"), S, budget);
  assert.ok(r.blocks.reduce((n, b) => n + b.body.length, 0) <= 64 * 1024);
});

test("a token-looking file name is masked in the listing and in the block header", () => {
  put(path.join(wt, "tok", TOKEN), "hello\n");
  const l = readPaths(["tok/"], S, { left: 10000 });
  assert.ok(!l.blocks[0].body.includes(TOKEN));
  assert.ok(!l.blocks[0].header.includes(TOKEN));
  const f = readPaths([`tok/${TOKEN}`], S, { left: 10000 });
  assert.ok(!f.blocks[0].header.includes(TOKEN));
  assert.ok(!f.blocks[0].body.includes(TOKEN));
});

test("added deny names are withheld", () => {
  for (const n of ["secrets.yaml", "secrets.yml", "secrets.json", "secrets.toml", "Secrets.YAML", "service-account.json", "service-account-prod.json", "kubeconfig", ".htpasswd", "api.token", "token.txt"]) {
    const p = put(path.join(wt, "d", n), "data\n");
    assert.equal(readPaths([p], S, { left: 10000 }).records[0].outcome, "withheld", n);
  }
  const l = readPaths(["d/"], S, { left: 10000 }).blocks[0].body;
  assert.ok(l.startsWith("(0 entries shown"), l);
  assert.equal(readPaths([put(path.join(wt, "d", "ok.txt"))], S, { left: 10000 }).records[0].outcome, "ok");
});

test("further deny names are withheld", () => {
  for (const n of ["service_account.json", "service_account-prod.json", "Service_Account.JSON", "client_secret.json", "client_secret_123.apps.json", "secret.txt", "Secret.yaml", ".secrets", "token"]) {
    const p = put(path.join(wt, "d2", n), "data\n");
    assert.equal(readPaths([p], S, { left: 10000 }).records[0].outcome, "withheld", n);
  }
  assert.equal(readPaths([put(path.join(wt, "d2", "tokens.txt"))], S, { left: 10000 }).records[0].outcome, "ok");
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
