// R46 item 7: the harness-native plan phase. Entered by PI_FOREMAN_PLAN_PHASE=1 (`foreman session open --plan-first`) or
// `/foreman plan`; while on: foreman changes only under .workflow/ (any edit mode), builders refused
// (launch_refused:plan_phase), explorers launch without a ledger (the core spawn gate is not called), no read reminder.
// Exit: a foreman_checkpoint approval or `/foreman plan off`. The phase persists in the ceremony-state entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { planRequired, world } from "./_r46world.ts";
import type { Block } from "./_r46world.ts";
import { planSummary } from "../checkpoint.ts";
import { bashPath } from "./_bashpath.ts";

const planPhase = (r: Block): boolean => r?.block === true && /\[launch_refused:plan_phase\]/.test(r.reason ?? "");
const READS = { foremanReads: { before: { warn: 1, every: 1 }, after: { warn: 1, every: 1 } } };

test("builder is refused in the plan phase (env entry); explorer and [plan-review] reviewer are allowed", async (t) => {
  const w = world(t);
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  assert.ok(planPhase(await a.launch("builder")), "builder");
  assert.equal((await a.reviewLaunch()).blocked, null, "a [plan-review] reviewer");
  assert.equal((w.ceremonyEntries().at(-1)!.data as { planPhase: boolean }).planPhase, true, "the env entry is recorded at once");
  const trace = await w.traceEvents();
  assert.ok(trace.some((e) => e.event === "launch_refused" && e.reason === "plan_phase"));
});

test("an explorer launches without a ledger and the core spawn gate is not called (plan_phase_explorer)", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.command("foreman", "plan");
  assert.equal(await a.launch("explorer"), undefined);
  const hits = (await w.traceEvents()).filter((e) => e.event === "plan_phase_explorer");
  assert.equal(hits.length, 1);
  await a.command("foreman", "plan off");
  assert.equal(await a.launch("explorer"), undefined);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "plan_phase_explorer").length, 1, "outside the phase the gate runs as before");
});

test("no read reminder in the plan phase (control: the reminder shows outside it)", async (t) => {
  const w = world(t, { ceremony: READS });
  const a = await w.adapter("startup");
  const reads = async () => {
    let note = "";
    for (const f of ["a.txt", "b.txt", "c.txt"]) note += (await a.call("read", { path: path.join(w.project, f) })).note;
    return note;
  };
  assert.match(await reads(), /read/i);
  await a.ownerPrompt(); // resets the read count
  await a.command("foreman", "plan");
  assert.equal((await reads()).replace(/ok/g, "").trim(), "");
});

test("write, edit, foreman_copy, foreman_move and shell writes outside .workflow/ are refused; .workflow/ stays writable (any edit mode)", async (t) => {
  for (const mode of ["bounded", "scratchpad", "readonly"]) {
    const w = world(t, { ceremony: { foremanEdits: mode } });
    const a = await w.adapter("startup");
    const src = path.join(w.project, "src", "a.ts");
    const wf = path.join(w.project, ".workflow", "notes.md");
    const outside: [string, Record<string, unknown>][] = [
      ["write", { path: src, content: "x" }],
      ["edit", { path: src, edits: [{ oldText: "a", newText: "b" }] }],
      ["foreman_copy", { src: wf, dst: src }],
      ["foreman_move", { src: wf, dst: src }],
      ["bash", { command: `echo x > ${bashPath(src)}` }],
    ];
    await a.command("foreman", "plan");
    for (const [tool, input] of outside) {
      const r = await a.checkCall(tool, input);
      assert.equal(r?.block, true, `${mode}: ${tool} outside .workflow/`);
      assert.match(r?.reason ?? "", /readonly|plan phase/i, `${mode}: ${tool}: the plan phase decides, not the triage gate`);
    }
    for (const [tool, input] of [["write", { path: wf, content: "x" }], ["edit", { path: wf, edits: [] }], ["foreman_copy", { src, dst: wf }], ["bash", { command: `echo x > ${bashPath(wf)}` }]] as [string, Record<string, unknown>][]) {
      assert.equal((await a.checkCall(tool, input))?.block, undefined, `${mode}: ${tool} into .workflow/`);
    }
  }
});

test("a foreman_checkpoint approval ends the plan phase and survives a reload", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.command("foreman", "plan");
  assert.ok(planPhase(await a.launch("builder")));
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal(await a.launch("builder"), undefined, "approved plan, phase over");
  assert.equal((w.ceremonyEntries().at(-1)!.data as { planPhase: boolean }).planPhase, false);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "plan_phase" && e.decision === "off" && e.cause === "checkpoint").length, 1);
  await a.down();
  const b = await w.adapter("reload");
  assert.equal(await b.launch("builder"), undefined);
});

test("/foreman plan off ends the phase; the model has no way out (a rejected or revised checkpoint keeps it)", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.command("foreman", "plan");
  assert.equal(await a.review("PASS"), null);
  w.state.answer = "reject";
  assert.equal((await a.checkpoint()).decision, "reject");
  assert.ok(planPhase(await a.launch("builder")), "reject keeps the phase");
  await a.command("foreman", "plan off");
  const after = await a.launch("builder");
  assert.ok(!planPhase(after) && planRequired(after), "the heavy gate decides again");
  assert.deepEqual(w.notes.filter((m) => /plan phase/.test(m)).length, 2);
});

test("/reload keeps the phase; an exit also holds across a reload even with the env still set", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.command("foreman", "plan");
  await a.down();
  const b = await w.adapter("reload");
  assert.ok(planPhase(await b.launch("builder")), "phase kept after /reload");
  await b.down();
  const c = await w.adapter("resume");
  assert.ok(planPhase(await c.launch("builder")), "and after resume");
  await c.command("foreman", "plan off");
  await c.down();
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const d = await w.adapter("reload");
  assert.ok(!planPhase(await d.launch("builder")), "the entry wins over the env");
});

test("the checkpoint summary shows `Open questions: N` when that section is not empty", () => {
  const body = (open: string) => `# Widget\n\n## Goal\nShip it.\n\n## Decisions and assumptions\n- one\n\n## Open questions\n${open}`;
  assert.match(planSummary(body("- Which db?\n- Which port?\n"), "p.md", "abcdef0123456789"), /^Open questions: 2$/m);
  assert.doesNotMatch(planSummary(body(""), "p.md", "abcdef0123456789"), /^Open questions:/m);
});
