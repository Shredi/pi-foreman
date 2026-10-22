// R26 item 4: a child's git add / git commit of a protected (write-ask) path is refused with text that names the foreman as
// the committer, and a builder brief says the same once; an explorer or reviewer brief does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { applyLedgerItems } from "../ledgerblock.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HINT = "The foreman stages and commits this file; report the needed change.";

test("r26 protected hint: the child shell deny on git add / git commit of a protected path names the foreman", () => {
  const baseline = readBaseline(PKG)!;
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r26-hint-")));
  try {
    fs.mkdirSync(path.join(ws, ".git"));
    fs.mkdirSync(path.join(ws, "config"));
    for (const f of ["package.json", path.join("config", "foreman.defaults.json")]) fs.writeFileSync(path.join(ws, f), "{}\n");
    const home = path.join(ws, "home");
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const rules = buildOverlayRules(baseline, {}, {}, agentDir, ws, undefined, true);
    const ctx = { cwd: ws, home, platform: process.platform, role: "child" as const };
    for (const command of ["git add package.json", "git add config/foreman.defaults.json", "git commit -m x package.json"]) {
      const d = checkToolCall(rules, "bash", { command }, ctx);
      assert.ok(d?.reason.includes(HINT), `${command}: ${JSON.stringify(d)}`);
    }
    // a secret deny is unchanged
    const other = checkToolCall(rules, "bash", { command: "git add .git/hooks/x" }, ctx);
    assert.ok(other && !other.reason.includes(HINT), JSON.stringify(other));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

const LINE = "Protected files (config/foreman.defaults.json, config/permissions.baseline.json, package.json and the other write-ask paths): report the needed change; the foreman applies and commits it.";
const ledger = "- [ ] 1. do a thing\n";

test("r26 protected hint: the builder brief carries the line, an explorer and a reviewer brief do not", () => {
  const brief = (agent: string, task: string) => {
    const input: Record<string, unknown> = { agent, task };
    applyLedgerItems(input, ledger);
    return input.task as string;
  };
  assert.ok(brief("builder", "implement item 1").includes(LINE));
  assert.ok(brief("builder", "implement the thing").includes(LINE), "also without a cited item");
  assert.ok(!brief("explorer", "look at item 1").includes(LINE));
  assert.ok(!brief("reviewer", "review item 1").includes(LINE));
});
