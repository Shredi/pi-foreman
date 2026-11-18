// D28 with the review gate per checkout: a PASS in one checkout while another stays open changes the refusal state (each checkout's verdict is part of the key,
// not only the combined gate, which stays null), so the refusals that follow count from zero again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { end, launch, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

type R = { continue?: boolean; entries?: { customType?: string }[] } | undefined;
const turnEnd = async (a: Rig): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
const kind = (r: R) => (r?.entries ?? []).map((e) => e.customType).join();
const pass = async (a: Rig, cwd?: string) => {
  const r = await launch(a, "reviewer", "[pre-pr] review the branch", cwd ? { cwd } : {});
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "reviewer", "Overall verdict: PASS", cwd);
};
const built = async (a: Rig, cwd?: string) => {
  const b = await launch(a, "builder", "build the widget", cwd ? { cwd } : {});
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", cwd);
};

test("a PASS in one of three checkouts starts a new refusal count; the open third checkout is not 'ceremony incomplete' after those refusals", async (t) => {
  const { a, w } = await setup(t);
  const b = worktree(w, "wtb");
  const c = worktree(w, "wtc");
  w.state.answer = "allow once";
  await built(a);
  await built(a, b);
  await built(a, c);
  assert.equal((await turnEnd(a))?.continue, true);
  assert.equal((await turnEnd(a))?.continue, true);
  await pass(a); // own checkout: a new state, the count starts at zero
  await tick(300);
  const afterOwn = await turnEnd(a);
  assert.equal(afterOwn?.continue, true, kind(afterOwn));
  assert.equal(kind(afterOwn), "pi-foreman-ceremony-gate");
  await pass(a, b); // second checkout: again a new state
  await tick(300);
  const afterB = await turnEnd(a);
  assert.equal(afterB?.continue, true, kind(afterB));
  assert.equal(kind(afterB), "pi-foreman-ceremony-gate");
  const again = await turnEnd(a);
  assert.equal(again?.continue, true, kind(again));
  const last = await turnEnd(a);
  assert.notEqual(last?.continue, true, "two refusals of the unchanged state, then the finish goes through");
  assert.equal(kind(last), "pi-foreman-ceremony-incomplete");
});
