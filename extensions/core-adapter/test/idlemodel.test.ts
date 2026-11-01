// Idle model downshift state machine (idlemodel.ts): fake deps, no Pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_ENTRY, IdleModel, latestIdleEntry, ownerAnswered, type CacheGlyph, type IdleEntry, type IdleModelDeps, type ModelRef } from "../idlemodel.ts";

const BASE: ModelRef = { provider: "p", id: "big" };
const IDLE: ModelRef = { provider: "p", id: "small" };

function rig(over: Partial<IdleModelDeps> = {}, opts: { cold?: boolean } = {}) {
  const st = { cur: { ...BASE } as ModelRef, thinking: "high", cold: opts.cold ?? true, setFails: false, missing: false, glyph: null as CacheGlyph | null };
  const traces: Record<string, unknown>[] = [];
  const entries: IdleEntry[] = [];
  const switched: { to: string; thinking: string | null }[] = [];
  const timers = { set: () => 1, clear: () => undefined };
  const deps: IdleModelDeps = {
    now: () => 1000,
    timers,
    enabled: () => true,
    causes: () => ["child", "wake", "intercom", "other"],
    rung: () => ({ model: "p/small", thinking: "low" }),
    current: () => st.cur,
    thinking: () => st.thinking,
    find: (spec) => (st.missing ? undefined : { provider: "p", id: spec.split("/")[1] }),
    findRef: (r) => ({ ...r }),
    switchTo: async (m, thinking) => {
      if (st.setFails) return false;
      const r = m as ModelRef;
      switched.push({ to: `${r.provider}/${r.id}`, thinking });
      st.cur = { provider: r.provider, id: r.id };
      if (thinking) st.thinking = thinking;
      return true;
    },
    coldAt: () => (st.cold ? 0 : Infinity),
    persist: (e) => entries.push(e),
    trace: (r) => traces.push(r),
    glyph: (g) => void (st.glyph = g),
    ...over,
  };
  return { im: new IdleModel(deps), st, traces, entries, switched };
}

for (const cause of ["child", "wake", "intercom", "other"]) {
  test(`cold notice turn (${cause}) downshifts to the idle rung with its thinking`, async () => {
    const r = rig();
    await r.im.beforeTurn(cause);
    assert.deepEqual(r.switched, [{ to: "p/small", thinking: "low" }]);
    assert.equal(r.im.downshifted(), true);
    assert.equal(r.im.baseModel(r.st.cur), "p/big");
    assert.deepEqual(r.entries[0], { base: { ...BASE, thinking: "high" }, idle: IDLE, open: true });
    assert.deepEqual(r.traces[0], { event: "foreman_model", from: "p/big", to: "p/small", reason: "idle_cold", cause });
    assert.equal(r.st.glyph, "downshift");
  });
}

test("a warm cache, a disabled feature, a cause outside the list and no rung never downshift", async () => {
  const warm = rig({}, { cold: false });
  await warm.im.beforeTurn("child");
  const off = rig({ enabled: () => false });
  await off.im.beforeTurn("child");
  const narrow = rig({ causes: () => ["wake"] });
  await narrow.im.beforeTurn("child");
  const none = rig({ rung: () => null });
  await none.im.beforeTurn("child");
  for (const r of [warm, off, narrow, none]) assert.equal(r.switched.length, 0);
  assert.equal(none.im.baseModel(none.st.cur), "p/big");
});

test("an unknown cause (null) and the rung equal to the current model do nothing", async () => {
  const a = rig();
  await a.im.beforeTurn(null);
  const b = rig({ rung: () => ({ model: "p/big", thinking: null }) });
  await b.im.beforeTurn("child");
  assert.equal(a.switched.length + b.switched.length, 0);
});

test("a custom-message run and a second notice turn: one downshift, base unchanged", async () => {
  const r = rig();
  await r.im.beforeTurn("child");
  await r.im.beforeTurn("wake");
  assert.equal(r.switched.length, 1);
  assert.equal(r.im.baseModel(r.st.cur), "p/big");
});

test("an owner turn restores the base model and thinking, then closes the entry", async () => {
  const r = rig();
  await r.im.beforeTurn("child");
  await r.im.beforeTurn("user");
  assert.deepEqual(r.switched[1], { to: "p/big", thinking: "high" });
  assert.equal(r.im.downshifted(), false);
  assert.equal(r.entries[1].open, false);
  assert.deepEqual(r.traces[1], { event: "foreman_model", from: "p/small", to: "p/big", reason: "owner" });
  assert.equal(r.st.glyph, "cold");
});

test("an owner turn without a downshift does nothing", async () => {
  const r = rig();
  await r.im.beforeTurn("user");
  assert.equal(r.switched.length + r.entries.length + r.traces.length, 0);
});

test("an owner answer restores; ownerAnswered tells answers from cancelled dialogs and fallbacks", async () => {
  assert.equal(ownerAnswered("ask_user_question", { decision: "answered" }), true);
  assert.equal(ownerAnswered("ask_user_question", { decision: "dismissed" }), false);
  assert.equal(ownerAnswered("ask_user_question", { decision: "no_ui" }), false);
  assert.equal(ownerAnswered("foreman_checkpoint", { decision: "approve", by: "owner" }), true);
  assert.equal(ownerAnswered("foreman_checkpoint", { decision: "revise", by: null }), true);
  assert.equal(ownerAnswered("foreman_checkpoint", { decision: "reject", by: null }), true);
  assert.equal(ownerAnswered("foreman_checkpoint", { decision: "approve", by: null }), false); // already approved, no dialog
  assert.equal(ownerAnswered("foreman_checkpoint", { decision: "pending", by: null }), false);
  assert.equal(ownerAnswered("bash", { decision: "answered" }), false);
  const r = rig();
  await r.im.beforeTurn("wake");
  await r.im.onAnswer();
  assert.equal(r.im.downshifted(), false);
  assert.equal(r.traces[1].reason, "answer");
});

test("a user /model pick while downshifted becomes the base: no restore later, later idles downshift again", async () => {
  const r = rig();
  await r.im.beforeTurn("child");
  r.st.cur = { provider: "p", id: "mine" };
  r.im.onUserPick();
  assert.equal(r.im.downshifted(), false);
  assert.equal(r.entries[1].open, false);
  await r.im.beforeTurn("user");
  assert.equal(r.switched.length, 1); // nothing restored
  await r.im.beforeTurn("child");
  assert.equal(r.im.baseModel(r.st.cur), "p/mine");
  r.im.onUserPick();
  const none = rig();
  none.im.onUserPick();
  assert.equal(none.entries.length, 0);
});

test("session_start closes an open persisted downshift when the model is still the idle rung", async () => {
  const open = { type: "custom", customType: IDLE_ENTRY, data: { base: { ...BASE, thinking: "high" }, idle: IDLE, open: true } };
  for (const reason of ["resume", "reload", "fork", "startup"]) {
    const r = rig();
    r.st.cur = { ...IDLE };
    await r.im.onSessionStart([{ type: "message" }, open]);
    assert.deepEqual(r.switched, [{ to: "p/big", thinking: "high" }], reason);
    assert.equal(r.entries[0].open, false);
    assert.equal(r.traces[0].reason, "session_start");
  }
});

test("session_start leaves a closed entry, or a different current model, alone", async () => {
  const entry = (open: boolean) => ({ type: "custom", customType: IDLE_ENTRY, data: { base: { ...BASE, thinking: null }, idle: IDLE, open } });
  const closed = rig();
  closed.st.cur = { ...IDLE };
  await closed.im.onSessionStart([entry(true), entry(false)]);
  const other = rig();
  other.st.cur = { provider: "p", id: "else" };
  await other.im.onSessionStart([entry(true)]);
  assert.equal(closed.switched.length + other.switched.length, 0);
});

test("session_start new restores from the in-memory base of the old session", async () => {
  const r = rig();
  await r.im.beforeTurn("intercom");
  await r.im.onSessionStart([]); // the new session's branch is empty
  assert.equal(r.im.downshifted(), false);
  assert.deepEqual(r.switched[1], { to: "p/big", thinking: "high" });
});

test("an unavailable rung (missing or setModel false) stays on base and is traced once", async () => {
  const missing = rig();
  missing.st.missing = true;
  await missing.im.beforeTurn("child");
  await missing.im.beforeTurn("child");
  assert.deepEqual(missing.traces, [{ event: "foreman_model", outcome: "unavailable", to: "p/small" }]);
  const fails = rig();
  fails.st.setFails = true;
  await fails.im.beforeTurn("child");
  await fails.im.beforeTurn("wake");
  assert.equal(fails.traces.length, 1);
  assert.equal(fails.im.downshifted(), false);
  assert.equal(fails.entries.length, 0);
});

test("glyph: warming, cold, downshifted; a running turn hides cold; nothing for an unknown TTL", async () => {
  const r = rig();
  r.im.refresh();
  assert.equal(r.st.glyph, "cold");
  r.im.setWarming(true);
  assert.equal(r.st.glyph, "keepalive");
  r.im.setWarming(false);
  r.im.setRunning(true);
  assert.equal(r.st.glyph, null);
  r.im.setRunning(false);
  await r.im.beforeTurn("child");
  r.im.setWarming(true);
  assert.equal(r.st.glyph, "downshift");
  const unknown = rig({ coldAt: () => Infinity });
  unknown.im.refresh();
  assert.equal(unknown.st.glyph, null);
});

test("foremanBaseModel feeds the review rule and the rank checks while downshifted", async () => {
  const { applyReviewModelRule } = await import("../reviewerclimb.ts");
  void applyReviewModelRule; // signature is exercised by the adapter; here the helper's value is what matters
  const r = rig();
  assert.equal(r.im.baseModel(r.st.cur), "p/big");
  await r.im.beforeTurn("child");
  assert.equal(r.st.cur.id, "small");
  assert.equal(r.im.baseModel(r.st.cur), "p/big"); // gates keep judging the base
  assert.equal(r.im.baseModel(null), "p/big");
  await r.im.beforeTurn("user");
  assert.equal(r.im.baseModel(r.st.cur), "p/big");
  assert.equal(r.im.baseModel(undefined), null);
});

test("cross-provider rung: the switch lands on the spec's provider, the gates keep the base, the restore returns to it", async () => {
  const other = { provider: "q", id: "cheap" };
  const r = rig({ rung: () => ({ model: "q/cheap", thinking: "low" }), find: (spec) => ({ provider: spec.split("/")[0], id: spec.split("/")[1] }) });
  await r.im.beforeTurn("child");
  assert.deepEqual(r.switched, [{ to: "q/cheap", thinking: "low" }]);
  assert.deepEqual(r.st.cur, other);
  assert.equal(r.im.baseModel(r.st.cur), "p/big");
  assert.deepEqual(r.im.baseRef(r.st.cur), BASE);
  assert.deepEqual(r.entries[0], { base: { ...BASE, thinking: "high" }, idle: other, open: true });
  assert.deepEqual(r.traces[0], { event: "foreman_model", from: "p/big", to: "q/cheap", reason: "idle_cold", cause: "child" });
  await r.im.beforeTurn("user");
  assert.deepEqual(r.st.cur, BASE);
  assert.deepEqual(r.switched[1], { to: "p/big", thinking: "high" });
  assert.equal(r.im.downshifted(), false);
  assert.deepEqual(r.im.baseRef(r.st.cur), BASE);
  assert.equal(r.im.baseRef(null), null);
});

test("cross-provider session_start closes an open entry whose idle model is on another provider", async () => {
  const other = { provider: "q", id: "cheap" };
  const open = { type: "custom", customType: IDLE_ENTRY, data: { base: { ...BASE, thinking: "high" }, idle: other, open: true } };
  const r = rig();
  r.st.cur = { ...other };
  await r.im.onSessionStart([open]);
  assert.deepEqual(r.switched, [{ to: "p/big", thinking: "high" }]);
  assert.equal(r.entries[0].open, false);
});

test("latestIdleEntry takes the newest valid entry", () => {
  const e = (open: boolean, id: string) => ({ type: "custom", customType: IDLE_ENTRY, data: { base: { provider: "p", id, thinking: "low" }, idle: IDLE, open } });
  assert.equal(latestIdleEntry([]), null);
  assert.equal(latestIdleEntry([e(true, "a"), e(false, "b")])?.open, false);
  assert.equal(latestIdleEntry([e(true, "a"), { type: "message" }])?.base.id, "a");
});
