// D28: finish refusals are counted per unchanged state (missing steps, work, review verdict), not per owner input, and persisted:
// at most two, then the finish goes through with the "ceremony incomplete" notice, also as a transcript message.
// Reproduction: an owner (interactive) input or a session restore between refusals used to reset the count, so the refusals never ended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./_r46world.ts";

const CLOSED = "# Ledger: x\nTier: standard\n\n- [x] 1. done\n- [x] V. fresh-eyes verification passed\n";
type R = { continue?: boolean; entries?: { customType?: string }[] } | undefined;

type World = ReturnType<typeof world>;
type Adapter = Awaited<ReturnType<World["adapter"]>>;
const settle = async (a: Adapter): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
const count = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event).length;
const types = (r: R) => (r?.entries ?? []).map((e) => e.customType);

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(CLOSED); // no open item: no pause, only the finish gate (builder and reviewer missing) can hold
  return { w, a };
}

test("two refusals per unchanged state, then the finish goes through with the notice; an interactive input or a restore between does not reset the count", async (t) => {
  const { w, a } = await rig(t);
  const notes: string[] = [];
  (a.ctx as { ui: { notify: (m: string) => void } }).ui.notify = (m: string) => void notes.push(m);
  const first = await settle(a);
  assert.equal(first?.continue, true);
  assert.deepEqual(types(first), ["pi-foreman-ceremony-gate"]);
  await a.ownerPrompt(); // an interactive input between refusals does not reset the count
  assert.equal((await settle(a))?.continue, true);
  const third = await settle(a);
  assert.notEqual(third?.continue, true, "the third turn end goes through");
  assert.deepEqual(types(third), ["pi-foreman-ceremony-incomplete"]);
  assert.match(String((third?.entries?.[0] as { content?: string }).content), /finished with ceremony incomplete: missing builder, reviewer/);
  assert.equal(await settle(a), undefined, "the message is appended once per state");
  assert.equal(await count(w, "finish_refused"), 2);
  assert.ok((await count(w, "ceremony_incomplete")) >= 1);
  assert.ok(notes.some((n) => /finished with ceremony incomplete: missing builder, reviewer/.test(n)), notes.join("\n"));
  // a restore after the notice does not append the message again
  assert.equal(await settle(await w.adapter("resume")), undefined);
  await a.ownerPrompt();
  assert.equal(await settle(a), undefined, "an interactive input after the notice starts no new refusals");

  // a builder run starts a fresh count; an interactive input and a session restore between its refusals keep it
  const run = await a.agentLaunch("builder", "build it");
  assert.equal(run.blocked, null);
  a.endRunAs(run.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
  const again = await settle(a);
  assert.equal(again?.continue, true, "the new state is refused again");
  assert.match(String((again?.entries?.[0] as { content?: string }).content), /requires reviewer;/);
  await a.ownerPrompt();
  const c = await w.adapter("resume");
  assert.equal((await settle(c))?.continue, true);
  const last = await settle(c);
  assert.notEqual(last?.continue, true);
  assert.deepEqual(types(last), ["pi-foreman-ceremony-incomplete"]);
  assert.equal(await count(w, "finish_refused"), 4);
});
