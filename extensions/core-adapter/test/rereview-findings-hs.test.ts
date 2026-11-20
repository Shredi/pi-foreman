// D128: the earlier-findings block follows the last FAIL: a normal FAIL after a high-stakes FAIL gets both blocks; a high-stakes FAIL after a normal FAIL only the high-stakes one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, end, hsRun, launch, setup, settle } from "./_hsrig.ts";

const EARLIER = "[pi-foreman earlier findings]";
const HS = "[pi-foreman high-stakes findings]";

async function normalFail(a: Awaited<ReturnType<typeof setup>>["a"]) {
  const s = await launch(a, "reviewer", "review items 1");
  assert.equal(s.blocked, null, String(s.blocked));
  await end(a, s, "reviewer", "1. FAIL src/n.ts:2 normal problem\nOverall verdict: FAIL");
  return s;
}

test("high-stakes FAIL then normal FAIL: the next re-review gets both blocks", async (t) => {
  const { a } = await setup(t);
  await build(a);
  await hsRun(a, "FAIL");
  await normalFail(a);
  await settle(a);
  const next = await launch(a, "reviewer", "review items 1");
  assert.equal(next.blocked, null, String(next.blocked));
  const task = String(next.input.task);
  assert.ok(task.includes(HS), task);
  assert.ok(task.includes(EARLIER) && task.includes("normal problem"), task);
});

test("normal FAIL then high-stakes FAIL: the next re-review gets only the high-stakes block", async (t) => {
  const { a } = await setup(t);
  await build(a);
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change"); // launched while the PASS stands, ends after the normal FAIL
  assert.equal(hs.blocked, null, String(hs.blocked));
  await end(a, await launch(a, "builder", "fix it"), "builder", "done");
  await normalFail(a);
  await end(a, hs, "reviewer", "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL");
  await settle(a);
  const next = await launch(a, "reviewer", "review items 1");
  assert.equal(next.blocked, null, String(next.blocked));
  const task = String(next.input.task);
  assert.ok(task.includes(HS), task);
  assert.ok(!task.includes(EARLIER) && !task.includes("normal problem"), task);
});
