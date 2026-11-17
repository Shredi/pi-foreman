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

test("text-only turn ends: two refusals, the third goes through with the notice and a transcript message, no more refusals", async (t) => {
  const { w, a } = await rig(t);
  const first = await settle(a);
  assert.equal(first?.continue, true);
  assert.deepEqual(types(first), ["pi-foreman-ceremony-gate"]);
  assert.equal((await settle(a))?.continue, true);
  const third = await settle(a);
  assert.notEqual(third?.continue, true, "the third turn end goes through");
  assert.deepEqual(types(third), ["pi-foreman-ceremony-incomplete"]);
  assert.match(String((third?.entries?.[0] as { content?: string }).content), /finished with ceremony incomplete: missing builder, reviewer/);
  assert.equal(await settle(a), undefined, "the message is appended once per state");
  assert.equal(await count(w, "finish_refused"), 2);
  assert.ok((await count(w, "ceremony_incomplete")) >= 1);
  assert.ok((a.ctx as { ui: { notify: unknown } }).ui.notify);
});

test("an interactive input between refusals does not reset the count", async (t) => {
  const { w, a } = await rig(t);
  assert.equal((await settle(a))?.continue, true);
  await a.ownerPrompt();
  assert.equal((await settle(a))?.continue, true);
  await a.ownerPrompt();
  const third = await settle(a);
  assert.notEqual(third?.continue, true);
  assert.deepEqual(types(third), ["pi-foreman-ceremony-incomplete"]);
  await a.ownerPrompt();
  assert.equal(await settle(a), undefined);
  assert.equal(await count(w, "finish_refused"), 2);
});

test("a session restore between refusals keeps the count", async (t) => {
  const { w, a } = await rig(t);
  assert.equal((await settle(a))?.continue, true);
  const b = await w.adapter("resume");
  assert.equal((await settle(b))?.continue, true);
  const c = await w.adapter("resume");
  const third = await settle(c);
  assert.notEqual(third?.continue, true);
  assert.deepEqual(types(third), ["pi-foreman-ceremony-incomplete"]);
  assert.equal(await count(w, "finish_refused"), 2);
});

test("a builder run between refusals starts a fresh count", async (t) => {
  const { w, a } = await rig(t);
  assert.equal((await settle(a))?.continue, true);
  assert.equal((await settle(a))?.continue, true);
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null);
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
  const again = await settle(a);
  assert.equal(again?.continue, true, "the new state is refused again");
  assert.match(String((again?.entries?.[0] as { content?: string }).content), /requires reviewer;/);
  assert.equal((await settle(a))?.continue, true);
  const last = await settle(a);
  assert.notEqual(last?.continue, true);
  assert.deepEqual(types(last), ["pi-foreman-ceremony-incomplete"]);
  assert.equal(await count(w, "finish_refused"), 4);
});
