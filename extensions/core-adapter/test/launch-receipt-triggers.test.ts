// D19: the launch receipt names the rung and every trigger that picked it, from the ladder's and sizing's own results;
// a launch with no trigger keeps the receipt unchanged and a refused launch leaves no note.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const RANKS = [{ match: "foreman*", tier: 0 }, { match: "top", tier: 1 }, { match: "strong", tier: 2 }, { match: "*", tier: 3 }];

async function rig(t: Parameters<typeof r11Rig>[0], o: { ceremony?: Record<string, unknown>; ranks?: unknown[]; top?: boolean; sizing?: Record<string, unknown> } = {}): Promise<Rig> {
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: "fake/strong" } } };
  const ladder = { sizing: { ...(o.top ? { topRung: "fake/top" } : {}), ...o.sizing } };
  return r11Rig(t, { default: "standard", ...o.ceremony }, { ctx: reviewAllowOpts().ctx, config: { providers: { fake: { review: { model: "m" }, roles, ...(o.ranks ? { ranks: o.ranks } : {}) } }, ladder } });
}

async function receipt(a: Rig, input: Record<string, unknown>): Promise<string> {
  const { id, res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  const out = (await a.started(id, input, `run-${id}`)) as { content: { text: string }[] } | undefined;
  return (out?.content ?? []).map((c) => c.text).filter((x) => x.startsWith("pi-foreman: launched")).join("\n");
}

const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });

test("a risk tag names the strong rung and the tag", async (t) => {
  const a = await rig(t);
  assert.equal(await receipt(a, builder({ risk: ["parser", "guard"] })), "pi-foreman: launched builder on fake/strong (strong rung: risk parser, guard).");
});

test("a design risk names the top rung", async (t) => {
  const a = await rig(t, { top: true });
  assert.equal(await receipt(a, builder({ risk: ["design"] })), "pi-foreman: launched builder on fake/top (top rung: risk design).");
});

test("a large file names the strong rung and the configured line limit", async (t) => {
  const a = await rig(t, { sizing: { largeFileLines: 1000 } });
  fs.writeFileSync(path.join(a.project, "big.py"), "x\n".repeat(1200));
  assert.equal(await receipt(a, builder({ size: { files: ["big.py"] } })), "pi-foreman: launched builder on fake/strong (strong rung: file over 1000 lines).");
});

test("too many modules name the strong rung and the configured module limit", async (t) => {
  const a = await rig(t, { sizing: { maxModules: 1 } });
  assert.equal(await receipt(a, builder({ size: { files: ["a/x/1.py", "b/y/2.py"] } })), "pi-foreman: launched builder on fake/strong (strong rung: over 1 modules).");
});

test("the heavy tier default names the strong rung", async (t) => {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ details: { decision: string } }> }>();
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: "fake/strong" } } };
  const a = await r11Rig(t, { default: "heavy", revisionRounds: { standard: 1 } }, { ctx: reviewAllowOpts().ctx, config: { providers: { fake: { review: { model: "m" }, roles } } }, piExtra: { registerTool: (d: { name: string }) => void tools.set(d.name, d as never) } });
  fs.mkdirSync(path.join(a.project, ".workflow", "scratch"), { recursive: true });
  fs.writeFileSync(path.join(a.project, ".workflow", "scratch", "plan-widget.md"), "# Widget\n\n## For the owner\n\nGoal: ship the widget.\n\n## Goal\nShip it.\n");
  const review = { agent: "reviewer", task: "[plan-review] review .workflow/scratch/plan-widget.md" };
  const { id, res } = await a.launch(review);
  assert.equal(res, undefined, res?.reason);
  await a.started(id, review, "run-plan");
  a.end({ runId: "run-plan", agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS" }] });
  await new Promise((r) => setTimeout(r, 25));
  const ck = await tools.get("foreman_checkpoint")!.execute("ck", { path: ".workflow/scratch/plan-widget.md" }, undefined, undefined, a.ctx);
  assert.equal(ck.details.decision, "approve");
  assert.equal(await receipt(a, builder()), "pi-foreman: launched builder on fake/strong (strong rung: heavy tier).");
});

test("an explicit strong with a reason and a sizing rule name both triggers once", async (t) => {
  const a = await rig(t);
  assert.equal(await receipt(a, builder({ model: "strong", reason: "hard parser", risk: ["parser"] })), "pi-foreman: launched builder on fake/strong (strong rung: explicit strong, risk parser).");
});

test("a revision after a FAIL names the trigger together with a sizing trigger", async (t) => {
  const a = await rig(t);
  const first = builder();
  const { id } = await a.launch(first);
  await a.started(id, first, "run-b");
  a.end({ runId: "run-b", agent: "builder", success: true, summary: "done" });
  const review = { agent: "reviewer", task: "review item 1" };
  const r = await a.launch(review);
  await a.started(r.id, review, "run-r");
  a.end({ runId: "run-r", agent: "reviewer", success: true, summary: "Verdict: FAIL\n- a finding" });
  assert.equal(await receipt(a, builder({ risk: ["security"] })), "pi-foreman: launched builder on fake/strong (strong rung: revision after FAIL, risk security).");
});

test("a sizing climb the rank policy refuses is named as skipped with its trigger", async (t) => {
  const a = await rig(t, { ranks: [{ match: "foreman*", tier: 2 }, { match: "strong", tier: 2 }, { match: "*", tier: 5 }] });
  fs.writeFileSync(path.join(a.project, "big.py"), "x\n".repeat(1700));
  assert.equal(await receipt(a, builder({ size: { files: ["big.py"] } })), "pi-foreman: launched builder on fake/builder (strong rung skipped by rank policy: file over 1500 lines).");
});

test("a launch with no trigger keeps the receipt unchanged", async (t) => {
  const a = await rig(t);
  assert.equal(await receipt(a, builder()), "pi-foreman: launched builder on fake/builder.");
});

test("a launch whose tool result is an error leaves no note for a later call", async (t) => {
  const a = await rig(t);
  const input = builder({ risk: ["parser"] });
  const { id } = await a.launch(input);
  await a.errored(id, input);
  const again = builder();
  const { id: id2 } = await a.launch(again);
  const out = (await a.started(id2, again, "run-2")) as { content: { text: string }[] } | undefined;
  assert.deepEqual((out?.content ?? []).map((c) => c.text).filter((x) => x.startsWith("pi-foreman: launched")), ["pi-foreman: launched builder on fake/builder."]);
});
