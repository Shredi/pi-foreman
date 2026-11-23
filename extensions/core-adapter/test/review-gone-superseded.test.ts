// D165: the finish gate drops a deleted checkout only when another checkout got a PASS after the deleted one's last build; a visible line names it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { supersededGone } from "../reviewgates.ts";
import type { ReviewGates } from "../reviewgates.ts";
import { build, end, git, launch, settle, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig, World } from "./_hsrig.ts";

const real = (p: string) => fs.realpathSync.native(p);
const gone = (...dirs: string[]) => (d: string) => !dirs.includes(d);

test("supersededGone: a gone open entry with a later PASS elsewhere is dropped and named", () => {
  const g: ReviewGates = {
    "/a": { last: "pass", revised: false, passAt: 200, builtAt: 100 },
    "/b": { last: null, revised: true, builtAt: 150 },
  };
  const r = supersededGone(g, gone("/b"));
  assert.deepEqual(Object.keys(r.gates), ["/a"]);
  assert.deepEqual(r.dropped, [{ dir: "/b", by: "/a" }]);
});

test("supersededGone: the only checkout, a PASS older than the build, no times and a gone PASSer keep blocking", () => {
  const only: ReviewGates = { "/b": { last: null, revised: true, builtAt: 150 } };
  assert.deepEqual(Object.keys(supersededGone(only, gone("/b")).gates), ["/b"]);
  const older: ReviewGates = { "/a": { last: "pass", revised: false, passAt: 100 }, "/b": { last: null, revised: true, builtAt: 150 } };
  assert.deepEqual(Object.keys(supersededGone(older, gone("/b")).gates).sort(), ["/a", "/b"]);
  const untimed: ReviewGates = { "/a": { last: "pass", revised: false, passAt: 200 }, "/b": { last: null, revised: true } };
  assert.deepEqual(Object.keys(supersededGone(untimed, gone("/b")).gates).sort(), ["/a", "/b"]);
  const bothGone: ReviewGates = { "/a": { last: "pass", revised: false, passAt: 200 }, "/b": { last: null, revised: true, builtAt: 150 } };
  assert.deepEqual(Object.keys(supersededGone(bothGone, gone("/b", "/a")).gates).sort(), ["/a", "/b"]);
});

test("supersededGone: a FAIL after the PASS keeps a gone entry; a live entry and the session-wide one are never dropped", () => {
  const failed: ReviewGates = { "/a": { last: "pass", revised: false, passAt: 200 }, "/b": { last: "fail", revised: false, builtAt: 100, failAt: 300 } };
  assert.deepEqual(Object.keys(supersededGone(failed, gone("/b")).gates).sort(), ["/a", "/b"]);
  const live: ReviewGates = { "/a": { last: "pass", revised: false, passAt: 200 }, "/b": { last: null, revised: true, builtAt: 100 }, "": { last: null, revised: true, builtAt: 100 } };
  assert.deepEqual(Object.keys(supersededGone(live, () => true).gates).sort(), ["", "/a", "/b"]);
});

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}
const rebuiltAndPassed = async (a: Rig): Promise<void> => {
  await tick(20);
  await build(a); // a builder in the own checkout, then its PASS: after B's last build
};
const lastGate = (w: World) => w.ceremonyEntries().at(-1)!.data as { gate?: { reviewGates?: Record<string, { builtAt?: number; passAt?: number }> } };

test("end to end: a deleted checkout built before a later PASS in the own checkout does not block, one visible line, the times survive a reload", async (t) => {
  const { a, w, b } = await two(t);
  await build(a);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  await end(a, nb, "builder", "done", b);
  git(w.project, "worktree", "remove", "--force", b);
  await rebuiltAndPassed(a);
  assert.equal(await settle(a), "");
  const lines = w.notes.filter((n) => n.includes("deleted, superseded by the PASS in"));
  assert.equal(lines.length, 1, w.notes.join("\n"));
  assert.ok(lines[0].includes(path.join(path.dirname(real(w.project)), "wtb")), lines[0]);
  assert.equal(await settle(a), "");
  assert.equal(w.notes.filter((n) => n.includes("deleted, superseded")).length, 1, "one line per dropped checkout");
  const gates = lastGate(w).gate?.reviewGates ?? {};
  const bk = Object.keys(gates).find((k) => k.endsWith("wtb"));
  assert.ok(bk && typeof gates[bk].builtAt === "number", "the build time is persisted");
  const own = gates[Object.keys(gates).find((k) => k && !k.endsWith("wtb")) as string];
  assert.ok(typeof own.passAt === "number" && own.passAt > (gates[bk].builtAt as number), "the PASS time is persisted");
  await a.down();
  const a2 = await w.adapter("reload");
  assert.equal(await settle(a2), "", "after a reload the gone checkout is still superseded");
});

test("end to end: a deleted checkout built after the only PASS keeps blocking", async (t) => {
  const { a, w, b } = await two(t);
  await build(a);
  await tick(20);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  await end(a, nb, "builder", "done", b);
  git(w.project, "worktree", "remove", "--force", b);
  assert.match(await settle(a), /wtb/);
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
});
