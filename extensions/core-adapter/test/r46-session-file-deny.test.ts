// R46 item 2 (protection scope): the Pi session files (*.jsonl directly in the current session dir, from
// ctx.sessionManager.getSessionFile()) are write-protected for the foreman and children; reads stay open for
// the foreman; subagent-artifacts/ and other subdirs are never covered (a child still writes its output there).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-sess-")));
const cwd = path.join(root, "proj");
const agentDir = path.join(root, "home", ".pi", "agent");
const sessionDir = path.join(agentDir, "sessions", "--proj--");
const sessionFile = path.join(sessionDir, "2026-01-01T00-00-00_abc.jsonl");
const art = path.join(sessionDir, "subagent-artifacts");
for (const d of [cwd, agentDir, art]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(sessionFile, "{}\n");

const guarded = buildOverlayRules(baseline, {}, {}, agentDir, path.join(root, "pkg"), undefined, false, undefined, sessionDir);
const plain = buildOverlayRules(baseline, {}, {}, agentDir, path.join(root, "pkg"));
const ctx = (role: "main" | "child"): MatchCtx => ({ cwd, home: path.join(root, "home"), platform: process.platform, role });
const kind = (rules: typeof guarded, tool: string, input: Record<string, unknown>, role: "main" | "child"): string => checkToolCall(rules, tool, input, ctx(role))?.kind ?? "pass";

test("session file: write tool, edit, foreman_move/copy destination and shell writes are denied for foreman and child", () => {
  const other = path.join(sessionDir, "older.jsonl");
  const calls: [string, Record<string, unknown>][] = [
    ["write", { path: sessionFile, content: "x" }],
    ["edit", { path: other }],
    ["foreman_copy", { src: path.join(cwd, "a"), dst: sessionFile }],
    ["foreman_move", { src: path.join(cwd, "a"), dst: other }],
    ["bash", { command: `echo '{}' >> ${sessionFile}` }],
    ["bash", { command: `echo x | tee ${sessionFile}` }],
    ["bash", { command: `sed -i s/a/b/ ${sessionFile}` }],
    ["bash", { command: `cp /etc/hosts ${sessionFile}` }],
    ["bash", { command: `mv x ${sessionFile}` }],
  ];
  for (const [tool, input] of calls) {
    for (const role of ["main", "child"] as const) {
      assert.equal(kind(guarded, tool, input, role), "deny", `${role}: ${tool} ${JSON.stringify(input)}`);
    }
  }
  // without the protection the foreman is not denied (the test fails without the rule)
  assert.notEqual(kind(plain, "write", { path: sessionFile, content: "x" }, "main"), "deny");
});

test("session file: reads stay allowed for the foreman", () => {
  assert.equal(kind(guarded, "read", { path: sessionFile }, "main"), "pass");
  assert.equal(kind(guarded, "bash", { command: `cat ${sessionFile}` }, "main"), "pass");
  assert.equal(kind(guarded, "bash", { command: `wc -l ${sessionFile}` }, "main"), "pass");
});

test("session dir: subagent-artifacts and other subdirs are not covered; non-jsonl files stay as before", () => {
  const same = (tool: string, input: Record<string, unknown>) => {
    for (const role of ["main", "child"] as const) assert.equal(kind(guarded, tool, input, role), kind(plain, tool, input, role), `${role}: ${tool} ${JSON.stringify(input)}`);
  };
  same("write", { path: path.join(art, "run1_output.md"), content: "x" });
  same("write", { path: path.join(art, "run1.jsonl"), content: "x" });
  same("write", { path: path.join(sessionDir, "nested", "x.jsonl"), content: "x" });
  same("write", { path: path.join(sessionDir, "notes.md"), content: "x" });
  same("bash", { command: `echo x > ${path.join(art, "run1_output.md")}` });
});
