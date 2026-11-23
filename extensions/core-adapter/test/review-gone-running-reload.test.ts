// D165: the running builders survive a reload: a builder ending after it still stamps the build time, one still running still shields its checkout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCeremonyState, CEREMONY_ENTRY, persistedGate, latestCeremonyState } from "../planstate.ts";
import { build, end, git, launch, settle, setup, tick, worktree } from "./_hsrig.ts";

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}

test("persistedGate: running builders round-trip, malformed entries drop, the newest 64 stay", () => {
  const m = new Map<string, string[] | null>();
  for (let i = 0; i < 70; i++) m.set(`r${i}`, i % 2 ? null : [`/x${i}`]);
  const g = persistedGate({ builder: 0, reviewer: 0 }, {}, {}, m);
  assert.equal(Object.keys(g.runningBuilders ?? {}).length, 64);
  assert.ok(!("r5" in (g.runningBuilders ?? {})) && "r69" in (g.runningBuilders ?? {}));
  assert.deepEqual(persistedGate({ builder: 0, reviewer: 0 }, {}, {}, new Map()).runningBuilders, undefined);
  const raw = { ...g, runningBuilders: { ok: ["/a"], nul: null, bad: [1], worse: "x" } };
  const entry = { ...buildCeremonyState({ plan: null, lineages: [], planPhase: false }), gate: raw };
  const back = latestCeremonyState([{ type: "custom", customType: CEREMONY_ENTRY, data: entry }]);
  assert.deepEqual(back?.gate?.runningBuilders, { ok: ["/a"], nul: null });
});

test("reload: launch in B, build and PASS in A, reload, B's builder ends, B deleted -> the finish stays refused", async (t) => {
  const { a, w, b } = await two(t);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  assert.equal(nb.blocked, null, String(nb.blocked));
  await tick(20);
  await build(a);
  await tick(20);
  await a.down();
  const a2 = await w.adapter("reload");
  await end(a2, nb, "builder", "done", b);
  git(w.project, "worktree", "remove", "--force", b);
  assert.match(await settle(a2), /wtb/);
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
});

test("reload: launch in B, build and PASS in A, reload, B deleted while its builder runs -> nothing dropped, refused once it ends", async (t) => {
  const { a, w, b } = await two(t);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  assert.equal(nb.blocked, null, String(nb.blocked));
  await tick(20);
  await build(a);
  await tick(20);
  await a.down();
  const a2 = await w.adapter("reload");
  git(w.project, "worktree", "remove", "--force", b);
  await settle(a2);
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
  await end(a2, nb, "builder", "done", b);
  assert.match(await settle(a2), /wtb/);
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
});
