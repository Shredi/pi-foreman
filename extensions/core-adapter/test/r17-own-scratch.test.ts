// R17 item 1, through the R41 gate: a write into the session's own `{cwd}/.pi/scratch/` and the rest of `{cwd}/.pi/*`. The old overlay split
// (reviewer for the scratch, selfMod human dialog for the rest) is gone; the gate's rules decide, and what they leave goes to the review
// (stubbed here: an allowing stub for the scratch lines, an asking stub for the rest, so the owner gets one gate dialog). Modelled on
// r16-auto-review.test.ts (real adapter via _r11rig).
// r79 item 11: the selfmod rule asks the owner (no classifier call); a target the parser cannot resolve is the dangerous class (an ask, the classifier
// has no model here); a plain scratch write is no rule and not dangerous, so mode auto runs it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gateOutcome, r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { SHELL_WRITE_REFUSAL } from "../shellwriteguard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Case = { name: string; line: string };
type ToolCase = { name: string; tool: string; input: Record<string, unknown> };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "r17-own-scratch.json"), "utf8")) as { reviewable: Case[]; selfMod: Case[]; reviewableTool: ToolCase[]; selfModTool: ToolCase[] };
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

const reply = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: "stub" });
let answer = reply("allow", "scratch-writes");
let calls = 0;
const base = reviewAllowOpts();
const modelRegistry = { ...(base.ctx.modelRegistry as object), complete: async () => (calls++, { content: [{ type: "text", text: answer }], stopReason: "stop" }) };
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => false, select: async () => (dialogs++, "deny with comment"), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: base.config });
const H = rig.handoff("own", "child");
fs.mkdirSync(path.join(rig.project, ".pi", "scratch"), { recursive: true });

async function run(tool: string, input: Record<string, unknown>, stub: "allow" | "ask"): Promise<{ outcome: string; dialogs: number; calls: number; reason?: string }> {
  answer = stub === "allow" ? reply("allow", "scratch-writes") : reply("ask", "tool-config-edit");
  const d0 = dialogs;
  const c0 = calls;
  const n0 = rig.trace().length;
  const res = await rig.call(tool, input);
  return { outcome: gateOutcome(rig.trace().slice(n0)), dialogs: dialogs - d0, calls: calls - c0, reason: res?.block ? res.reason : undefined };
}
const fill = (s: string): string => s.replace(/\{H\}/g, inBash(H));
const bash = (line: string, stub: "allow" | "ask") => run("bash", { command: fill(line) }, stub);

for (const c of FX.reviewable) {
  test(`r17 own scratch ${c.name}: default-write-in decides, no review, no dialog`, async () => {
    const r = await bash(c.line, "allow");
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allowed:default-write-in", 0, 0]);
  });
}

// ruling-10: every selfMod line is a foreman shell write into project files, which the edit mode refuses; the refusal comes before the selfmod rule's
// dialog and before the review (an unresolvable target included), so there is no dialog and no model call
for (const c of FX.selfMod) {
  test(`r17 selfMod ${c.name}: the shell write refusal, no dialog, no model call`, async () => {
    const r = await bash(c.line, "ask");
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["pass", 0, 0]);
    assert.ok(r.reason?.includes(SHELL_WRITE_REFUSAL), String(r.reason));
  });
}

for (const c of FX.reviewableTool) {
  test(`r17 own scratch tool ${c.name}: path-write-worktree, no review, no dialog`, async () => {
    const r = await run(c.tool, c.input, "allow");
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allowed:path-write-worktree", 0, 0]);
  });
}

for (const c of FX.selfModTool) {
  test(`r17 selfMod tool ${c.name}: the selfmod rule asks, one dialog, no model call`, async () => {
    const r = await run(c.tool, c.input, "ask");
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["dialog:selfmod:comment", 1, 0]);
  });
}
