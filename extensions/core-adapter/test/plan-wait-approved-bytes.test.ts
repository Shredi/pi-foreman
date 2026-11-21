// Report 74f9c6d3407e: a heavy child's "waits for:" line said "nothing; it goes on to build" while it waited at its checkpoint. The round state the child writes
// says the plan is open unless the current plan bytes are the approved bytes, and it is written when a checkpoint turns pending.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { planWait } from "../roundstate.ts";
import { PLAN, tick, world } from "./_r46world.ts";

const OWNER = "waits for: the owner's approval at its pane; nothing from you";
const BUILD = "waits for: nothing; it goes on to build";
const ASK = "waits for: its own plan review and the owner's approval at its pane; nothing from you";
const REL = ".workflow/scratch/plan-widget.md";

test("T9: an approved version whose bytes changed is not approved: the plan edited after the approval, then reviewed again, waits for the owner", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  await a.ownerPrompt(); // the session's first prompt writes the file
  assert.equal(planWait(w.handoff).text, ASK);
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal(planWait(w.handoff).text, BUILD);
  fs.writeFileSync(w.planFile, PLAN.replace("Ship it.", "Ship it again."));
  assert.equal(await a.review("PASS"), null); // the run end writes the round state
  assert.equal(planWait(w.handoff).text, OWNER, "the approved version is old: the edited plan waits for the owner");
});

test("T9: the checkpoint of a changed plan, still pending at its dialog, is on file before the owner answers", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  fs.writeFileSync(w.planFile, PLAN.replace("Ship it.", "Ship it twice."));
  assert.equal(await a.review("PASS"), null);
  let release: (v: string) => void = () => undefined;
  (a.ctx as { ui: { select: () => Promise<string> } }).ui.select = () => new Promise<string>((r) => { release = r; });
  const open = a.checkpoint(); // the dialog is open
  await tick(100);
  assert.equal(planWait(w.handoff).text, OWNER, "the file says the owner is asked while the dialog is open");
  release("approve");
  assert.equal((await open).decision, "approve");
  assert.equal(planWait(w.handoff).text, BUILD);
});

test("T9: the state file is written before a `Plan from` notice is sent", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  fs.writeFileSync(w.planFile, PLAN.replace("Ship it.", "Ship it thrice."));
  assert.equal(planWait(w.handoff).text, BUILD, "stale until something writes it");
  await a.fire("tool_call", { toolName: "intercom", toolCallId: "i1", input: { action: "send", to: "parent", message: `Plan from child: ${REL}` } });
  assert.equal(planWait(w.handoff).text, ASK, "written before the send: the edited plan is not reviewed or approved");
});
