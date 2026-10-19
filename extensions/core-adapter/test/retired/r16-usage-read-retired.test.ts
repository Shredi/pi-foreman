// R16 item 4c (ruling D2): the retired rows of r12-state-read.test.ts after permoverlay.ts ownRead dropped the USAGE_VERBS chain and the
// usagePythonRead/usageNodeRead wrappers; ownStateRead is the one deterministic own-read allow. Every row runs through the real adapter
// (test/_r11rig.ts) as the foreman with an allowing stubbed reviewer: a row ownStateRead covers passes with no model call, a reviewed row is
// allowed with one model call, a self-modification ask goes to the human (denied, no model call). The rows and their notes: usage-read-rows.json.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig } from "../_r11rig.ts";
import * as overlay from "../../permoverlay.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Row = { test: string; line: string; expect: "pass" | "review" | "human" };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "usage-read-rows.json"), "utf8")) as { rows: Row[] };
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const posix = process.platform !== "win32";

// the stubbed reviewer allows and counts its calls; the human: every dialog is counted and denied
let calls = 0;
let dialogs = 0;
const modelRegistry = {
  find: () => ({ cost: { input: 1 } }),
  getProviderAuthStatus: () => ({ configured: true }),
  complete: async () => (calls++, { content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" }),
};
const ui = { notify: () => undefined, confirm: async () => (dialogs++, false), select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: { providers: { fake: { review: { model: "fake/small", timeoutMs: 2000 } } } } });

const state = path.join(rig.agentDir, "pi-foreman", "state");
const usageDir = path.join(state, "usage");
const usage = path.join(usageDir, `${rig.sessionId}.jsonl`);
fs.mkdirSync(usageDir, { recursive: true });
if (!fs.existsSync(usage)) fs.writeFileSync(usage, "{}\n");
const fill = (line: string): string => line.replace(/\{usage\}/g, inBash(usage)).replace(/\{usageDir\}/g, inBash(usageDir)).replace(/\{state\}/g, inBash(state));

async function run(row: Row): Promise<{ outcome: string; calls: number; dialogs: number }> {
  const [c0, d0, n0] = [calls, dialogs, rig.trace().length];
  await rig.call("bash", { command: fill(row.line) });
  const recs = rig.trace().slice(n0);
  const ov = recs.find((x) => x.event === "overlay");
  const outcome = recs.some((x) => x.event === "auto_review_allow") ? "review" : !ov ? "pass" : ov.decision === "ask-denied" && ov.by !== "auto" ? "human" : String(ov.decision);
  return { outcome, calls: calls - c0, dialogs: dialogs - d0 };
}

for (const row of FX.rows) {
  test(`${row.test} (retired rig: ${row.expect === "pass" ? "ownStateRead, no model call" : row.expect === "review" ? "the auto reviewer allows" : "the human dialog, no model call"}: ${row.line})`, { skip: !posix }, async () => {
    const r = await run(row);
    assert.deepEqual([r.outcome, r.calls, r.dialogs], [row.expect, row.expect === "review" ? 1 : 0, row.expect === "human" ? 1 : 0]);
  });
}

test("state_usage_node_e_read: usagePythonRead/usageNodeRead are gone (retired: ownStateRead is the one own-read decision)", () => {
  assert.equal("usageNodeRead" in overlay, false);
  assert.equal("usagePythonRead" in overlay, false);
  assert.equal(typeof overlay.ownStateRead, "function");
});
