// Loop guard through the adapter (reviewloop.ts, index.ts): FAIL, builder, FAIL with the same findings stops the loop with [review_loop];
// [second-opinion] stays allowed; an owner prompt or a parent brief lifts it; no count refuses anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tick, world } from "./_r46world.ts";
import { FAIL_REPORT, codeReview, loopRefused, stopLoop } from "./_loopstop.ts";

const standard = { ceremony: { default: "standard" } };

test("the second FAIL with the same findings stops builder and reviewer launches, not [second-opinion]", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  assert.equal((await w.traceEvents()).filter((r) => r.event === "review_loop").length, 1);
  assert.ok(loopRefused(await a.launch("builder")), "builder");
  assert.ok(loopRefused(await codeReview(a, FAIL_REPORT, 3)), "reviewer");
  assert.equal((await a.reviewLaunch("[second-opinion] is the approach sound?")).blocked, null, "second opinion");
  assert.equal(await a.launch("explorer"), undefined, "explorer");
});

test("the stop is persisted across a reload", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  await a.down();
  const b = await w.adapter("reload");
  assert.ok(loopRefused(await b.launch("builder")));
});

test("an owner prompt lifts the stop", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  assert.ok(loopRefused(await codeReview(a, FAIL_REPORT, 3)));
  await a.ownerPrompt();
  assert.equal(await a.launch("builder"), undefined);
});

test("a parent brief lifts the stop", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  assert.ok(loopRefused(await a.launch("builder")));
  fs.writeFileSync(path.join(w.handoff, "brief-1.md"), "go on differently\n");
  assert.equal(await a.launch("builder"), undefined);
});

test("a FAIL with different findings, and a PASS between, do not stop the loop", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, FAIL_REPORT, 1), null);
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await codeReview(a, "2. FAIL: another\nOverall verdict: FAIL", 2), null);
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await codeReview(a, "Overall verdict: PASS", 3), null);
  assert.equal((await w.traceEvents()).filter((r) => r.event === "review_loop").length, 0);
});

test("plan and code rounds are separate kinds: a plan FAIL after a code FAIL with the same item does not stop", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, FAIL_REPORT, 1), null);
  const r = await a.reviewLaunch();
  assert.equal(r.blocked, null);
  a.endRun(r.id, FAIL_REPORT);
  await tick(400);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "review_loop").length, 0);
  assert.equal(await a.launch("builder"), undefined);
});

test("no count refuses: more than 3 reviews and more than 2 revision rounds in one prompt run through", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  for (let i = 1; i <= 6; i++) {
    assert.equal(await codeReview(a, `${i}. FAIL: finding ${i}\nOverall verdict: FAIL`, i), null, `review ${i}`);
    assert.equal(await a.launch("builder"), undefined, `builder ${i}`);
  }
  const trace = await w.traceEvents();
  assert.equal(trace.filter((r) => r.event === "review_loop").length, 0);
  assert.equal(trace.filter((r) => r.event === "launch_refused").length, 0);
});
