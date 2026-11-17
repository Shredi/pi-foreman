// Security review cycle 2 fixes (cycle 3): U1 project/user Claude config, U2 git config,
// U3 credential files and commands, T3 symlinked parent + new leaf, T11 package root in child
// shells, T14 `<rev>:<path>` words, U5/U6 review truncation and fencing, U15 unknown decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isolationDoctor, projectClaudeRisks } from "../bridgeiso.ts";
import { parseHookStdout } from "../translate.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-c3-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("U1 doctor: project hooks, apiKeyHelper and .mcp.json are findings; plain settings are not", () => {
  const p = fs.mkdtempSync(path.join(root, "risk-"));
  assert.deepEqual(projectClaudeRisks(p), []);
  fs.mkdirSync(path.join(p, ".claude"));
  fs.writeFileSync(path.join(p, ".claude", "settings.json"), JSON.stringify({ permissions: {} }));
  assert.deepEqual(projectClaudeRisks(p), []);
  fs.writeFileSync(path.join(p, ".claude", "settings.local.json"), JSON.stringify({ hooks: {}, apiKeyHelper: "x" }));
  fs.writeFileSync(path.join(p, ".mcp.json"), "{}");
  assert.deepEqual(projectClaudeRisks(p), [".claude/settings.local.json (hooks, apiKeyHelper)", ".mcp.json"]);
});

test("U14 doctor: cloud-fetched files in the isolation folder are INFO, not FAIL", () => {
  const dir = fs.mkdtempSync(path.join(root, "iso-"));
  fs.writeFileSync(path.join(dir, "remote-settings.json"), "{}");
  fs.writeFileSync(path.join(dir, "policy-limits.json"), "{}");
  const lines = isolationDoctor({ dir, env: {}, platform: "linux" });
  assert.ok(!lines.some((l) => l.startsWith("FAIL")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("INFO") && l.includes("remote-settings.json, policy-limits.json")));
});

test("U15: an unknown or wrong-case permissionDecision is unreadable output, never an allow", () => {
  const out = (pd: unknown) => parseHookStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: pd } }));
  assert.deepEqual(out("Deny"), { ok: false });
  assert.deepEqual(out("block"), { ok: false });
  assert.deepEqual(out(1), { ok: false });
  assert.equal((out("deny") as { d: { decision: string } }).d.decision, "deny");
  assert.equal((out(undefined) as { d: { decision: string } }).d.decision, "none");
});
