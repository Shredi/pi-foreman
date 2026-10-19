// R16 item 4a (ruling D1): the retired rows of the self-ruling tests (r6/r9/r10/r13/r14, s2-deny-trace) after ruling.ts kept only the
// plain literal-path deny and the flat ask trigger. Every row runs through the real adapter (test/_r11rig.ts) with a stubbed reviewer:
// a plain-path row is refused with no model call, a trick row the trigger catches is the reviewer's (a denying stub denies, an allowing
// stub allows), a row that triggers nothing any more asserts what the adapter does now. The rows and their notes: self-ruling-rows.json.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig } from "../_r11rig.ts";
import * as ruling from "../../ruling.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Row = { test: string; line: string; tool?: string; cwd?: string; expect: string; outcome?: string; reason?: string };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "self-ruling-rows.json"), "utf8")) as { plainDeny: Row[]; rows: Row[] };
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const ALLOW = '{"verdict":"allow"}';
const DENY = '{"verdict":"deny","reason":"no","riskLevel":"high"}';

// the stubbed reviewer: every model call is counted; the human: every dialog is counted and denied
let answer = ALLOW;
let calls = 0;
let dialogs = 0;
let lastPrompt = "";
const modelRegistry = {
  find: () => ({ cost: { input: 1 } }),
  getProviderAuthStatus: () => ({ configured: true }),
  complete: async (_m: unknown, context: unknown) => {
    calls++;
    lastPrompt = (context as { messages: { content: string }[] }).messages[0].content;
    return { content: [{ type: "text", text: answer }], stopReason: "stop" };
  },
};
const ui = { notify: () => undefined, confirm: async () => (dialogs++, false), select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: { providers: { fake: { review: { model: "fake/small", timeoutMs: 2000 } } } } });

const up = rig.handoff("up", "child");
const own = rig.handoff("own", "child");
const down = rig.handoff("down", "parent");
const hand = path.dirname(up);
const S = path.join(rig.project, "scratch");
fs.mkdirSync(S, { recursive: true });
fs.mkdirSync(path.join(rig.project, ".workflow", "scratch"), { recursive: true });
for (const [f, t] of [[path.join(up, "ruling.md"), "APPROVED\n"], [path.join(up, "plan.md"), "plan\n"], [path.join(up, "brief.md"), "brief\n"], [path.join(own, "ruling-2.md"), "APPROVED\n"], [path.join(own, "asks.md"), "asks\n"], [path.join(S, "x"), "x\n"], [path.join(S, "usage.json"), "{}\n"]]) fs.writeFileSync(f, t);
try {
  fs.symlinkSync(up, path.join(S, "lnk"), "dir");
} catch {
  // no symlink right (win32): the line alone decides
}
const fill = (line: string): string => line.replace(/\{up\}/g, inBash(up)).replace(/\{own\}/g, inBash(own)).replace(/\{down\}/g, inBash(down)).replace(/\{hand\}/g, inBash(hand)).replace(/\{root\}/g, inBash(rig.project)).replace(/\{S\}/g, inBash(S));

async function run(row: Row, reply: string): Promise<{ outcome: string; selfRuling: boolean; calls: number; dialogs: number; reason: string }> {
  answer = reply;
  const [c0, d0, n0] = [calls, dialogs, rig.trace().length];
  const ctx = rig.ctx as { cwd: string };
  if (row.cwd === "hand") ctx.cwd = hand;
  try {
    await rig.call(row.tool ?? "bash", { command: fill(row.line) });
  } finally {
    ctx.cwd = rig.project;
  }
  const recs = rig.trace().slice(n0);
  const ov = recs.find((x) => x.event === "overlay");
  const outcome = recs.some((x) => x.event === "guard" && x.guard === "self_ruling")
    ? "refused"
    : recs.some((x) => x.event === "auto_review_allow")
      ? "allow"
      : !ov
        ? "pass"
        : ov.decision === "deny"
          ? ov.by === "auto" ? "model-deny" : "deny"
          : String(ov.decision);
  // the reviewer saw the self-ruling rule (the prompt's rule line), or the allow record names it
  const selfRuling = recs.some((x) => x.rule === "self-ruling") || (calls > c0 && lastPrompt.includes("rule: self-ruling"));
  return { outcome, selfRuling, calls: calls - c0, dialogs: dialogs - d0, reason: String(ov?.reason ?? "") };
}

for (const row of FX.plainDeny) {
  test(`${row.test} (retired rig: the plain-path deny, no model call)`, async () => {
    const r = await run(row, ALLOW);
    assert.deepEqual([r.outcome, r.calls, r.dialogs], ["refused", 0, 0]);
  });
}

for (const row of FX.rows) {
  test(`${row.test} (retired rig: ${row.expect === "ask" ? "the self-ruling ask" : `now ${row.outcome}`}${FX.rows.filter((x) => x.test === row.test).length > 1 ? `: ${row.line.split("\n")[0]}` : ""})`, async () => {
    if (row.expect === "ask") {
      const deny = await run(row, DENY);
      assert.deepEqual([deny.outcome, deny.selfRuling, deny.calls, deny.dialogs], ["model-deny", true, 1, 0]);
      const allow = await run(row, ALLOW);
      assert.deepEqual([allow.outcome, allow.selfRuling, allow.calls, allow.dialogs], ["allow", true, 1, 0]);
    } else {
      const r = await run(row, ALLOW);
      assert.deepEqual([r.outcome, r.selfRuling], [row.outcome, false]);
      // the guard that decides now, named by its reason
      if (row.reason) assert.ok(r.reason.includes(row.reason), r.reason);
    }
  });
}

test("r13 shellFacts: a redirect target is reported with its resolved path (retired: ruling.ts no longer runs scripts/shell_facts.py)", () => {
  assert.equal("shellFacts" in ruling, false);
  assert.equal(typeof ruling.selfRulingAsk, "function");
});
