// R17 item 1: a write into the session's own `{cwd}/.pi/scratch/` is not selfMod, so the overlay ask goes to the (stubbed) auto reviewer
// and not to the human dialog; the rest of `{cwd}/.pi/*` stays selfMod. Modelled on r16-auto-review.test.ts (real adapter via _r11rig).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig } from "./_r11rig.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Case = { name: string; line: string };
type ToolCase = { name: string; tool: string; input: Record<string, unknown> };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "r17-own-scratch.json"), "utf8")) as { reviewable: Case[]; selfMod: Case[]; reviewableTool: ToolCase[]; selfModTool: ToolCase[] };
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

let calls = 0;
const modelRegistry = {
  find: () => ({ cost: { input: 1 } }),
  getProviderAuthStatus: () => ({ configured: true }),
  complete: async () => (calls++, { content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" }),
};
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => (dialogs++, false), select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: { providers: { fake: { review: { model: "fake/small", timeoutMs: 50 } } } } });
const H = rig.handoff("own", "child");
fs.mkdirSync(path.join(rig.project, ".pi", "scratch"), { recursive: true });

async function run(tool: string, input: Record<string, unknown>): Promise<{ outcome: string; dialogs: number; calls: number }> {
  const d0 = dialogs;
  const c0 = calls;
  const n0 = rig.trace().length;
  await rig.call(tool, input);
  const recs = rig.trace().slice(n0);
  const ov = recs.find((x) => x.event === "overlay");
  const outcome = recs.some((x) => x.event === "auto_review_allow") ? "allow" : !ov ? "pass" : String(ov.decision);
  return { outcome, dialogs: dialogs - d0, calls: calls - c0 };
}
const fill = (s: string): string => s.replace(/\{H\}/g, inBash(H));
const bash = (line: string) => run("bash", { command: fill(line) });

for (const c of FX.reviewable) {
  test(`r17 own scratch ${c.name}: the reviewer decides, no dialog`, async () => {
    const r = await bash(c.line);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allow", 0, 1]);
  });
}

for (const c of FX.selfMod) {
  test(`r17 selfMod ${c.name}: the human dialog, no model call`, async () => {
    const r = await bash(c.line);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
  });
}

for (const c of FX.reviewableTool) {
  test(`r17 own scratch tool ${c.name}: the reviewer decides, no dialog`, async () => {
    const r = await run(c.tool, c.input);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allow", 0, 1]);
  });
}

for (const c of FX.selfModTool) {
  test(`r17 selfMod tool ${c.name}: the human dialog, no model call`, async () => {
    const r = await run(c.tool, c.input);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
  });
}
