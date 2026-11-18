// D70 through the adapter hooks: a single launch carries ladder.contextCap in its binding on every rung, and a top-rung run that stopped at the cap
// hands its report to the next foreman-written `strong` launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const ROLES = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: "fake/strong" } } };
const ladderOf = (input: Record<string, unknown>) => ((input.extensionBindings as Record<string, { ladder?: Record<string, unknown> }> | undefined)?.["pi-foreman/1"])?.ladder;

const rig = (t: Parameters<typeof r11Rig>[0], ladder?: Record<string, unknown>): Promise<Rig> =>
  r11Rig(t, { default: "standard" }, {
    ctx: { ...reviewAllowOpts().ctx, model: { provider: "fake", id: "foreman" } },
    config: { providers: { fake: { review: { model: "m" }, roles: ROLES } }, ...(ladder ? { ladder } : {}) },
  });

test("a single builder launch carries contextCap 250000 on the bottom and the top rung; reviewers none", async (t) => {
  const a = await rig(t);
  const bottom: Record<string, unknown> = { agent: "builder", task: "go" };
  assert.equal((await a.launch(bottom)).res, undefined);
  assert.deepEqual([ladderOf(bottom)?.bottom, ladderOf(bottom)?.contextCap], [true, 250000]);
  const top: Record<string, unknown> = { agent: "builder", task: "go", model: "strong", reason: "big change" };
  assert.equal((await a.launch(top)).res, undefined);
  assert.deepEqual([ladderOf(top)?.bottom, ladderOf(top)?.contextCap], [false, 250000]);
  const rev: Record<string, unknown> = { agent: "reviewer", task: "review items 1 of the diff" };
  assert.equal((await a.launch(rev)).res, undefined);
  assert.equal(ladderOf(rev)?.contextCap, undefined);
});

test("ladder.contextCap.builder sets the value, 0 leaves it out", async (t) => {
  const set = await rig(t, { contextCap: { builder: 90000 } });
  const a: Record<string, unknown> = { agent: "builder", task: "go" };
  await set.launch(a);
  assert.equal(ladderOf(a)?.contextCap, 90000);
  const off = await rig(t, { contextCap: { builder: 0 } });
  const b: Record<string, unknown> = { agent: "builder", task: "go" };
  await off.launch(b);
  assert.equal(ladderOf(b)?.contextCap, undefined);
});

test("a top-rung builder that stopped at the cap: the next strong launch needs no reason, keeps strong and carries the report once", async (t) => {
  const a = await rig(t);
  const first: Record<string, unknown> = { agent: "builder", task: "item 2: build the parser", model: "strong", reason: "big change" };
  const l = await a.launch(first);
  assert.equal(l.res, undefined);
  await a.started(l.id, first, "cap-run-1");
  a.end({ runId: "cap-run-1", agent: "builder", status: "completed", success: true, summary: "RUNG_UP: context\nDone: parser\nRemaining: tests", results: [{ agent: "builder", status: "completed", success: true, output: "RUNG_UP: context\nDone: parser\nRemaining: tests" }] });
  await new Promise((r) => setTimeout(r, 100));
  const second: Record<string, unknown> = { agent: "builder", task: "item 2: build the parser", model: "strong" };
  assert.equal((await a.launch(second)).res, undefined, "no strong_no_reason");
  assert.match(String(second.task), /^\[pi-foreman rung-up handoff\] The previous builder run cap-run-1 stopped \(context\)/);
  assert.match(String(second.task), /Done: parser/);
  assert.equal(second.model, "fake/strong", "still the strong rung");
  assert.deepEqual(a.events("rung_top").map((r) => r.reason), ["context"]);
  const third: Record<string, unknown> = { agent: "builder", task: "again", model: "strong", reason: "r" };
  assert.equal((await a.launch(third)).res, undefined);
  assert.doesNotMatch(String(third.task), /rung-up handoff/);
});
