// R39: launch sizing through the real adapter hooks (index.ts tool_call): the strip, the rung from the measured size and risk,
// the explicit-model rules, pressure, the trivial tier, the top rung, the probe line and the launch_sizing trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pressurePath } from "../pressure.ts";
import { r11Rig } from "./_r11rig.ts";

const ROLE_IDS = ["explorer", "planner", "reviewer", "senior-reviewer", "finalizer"];
const BIG = "x\n".repeat(1700);
const RANKS = [{ match: "foreman*", tier: 0 }, { match: "huge", tier: 1 }, { match: "strong", tier: 2 }, { match: "*", tier: 3 }];

function providers(o: { strong?: boolean; ranks?: unknown[] } = {}): Record<string, unknown> {
  const roles: Record<string, unknown> = Object.fromEntries(ROLE_IDS.map((r) => [r, { model: `fake/${r}` }]));
  roles.builder = { model: "fake/builder", ...(o.strong === false ? {} : { strong: { model: "fake/strong" } }) };
  return { fake: { roles, ...(o.ranks ? { ranks: o.ranks } : {}) } };
}

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const big = (a: Rig, rel = "big.py"): void => void fs.writeFileSync(path.join(a.project, rel), BIG);
const sizing = (a: Rig): Record<string, unknown>[] => a.events("launch_sizing");
const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });

async function rig(t: Parameters<typeof r11Rig>[0], o: { strong?: boolean; ranks?: unknown[]; ceremony?: Record<string, unknown> } = {}): Promise<Rig> {
  return r11Rig(t, { default: "standard", ...o.ceremony }, { config: { providers: providers(o) } });
}

test("size and risk are stripped on every launch path", async (t) => {
  const a = await rig(t);
  const fields = { size: { files: ["a.py"] }, risk: ["guard"] };
  const plain = builder({ ...fields });
  assert.equal((await a.launch(plain)).res, undefined);
  assert.ok(!("size" in plain) && !("risk" in plain));
  const tasks = { ...fields, tasks: [builder({ ...fields }), { agent: "explorer", task: "look", ...fields }] };
  assert.equal((await a.launch(tasks)).res, undefined);
  const chain = { chain: [{ agent: "explorer", task: "look", ...fields }, { parallel: [{ agent: "explorer", task: "a", ...fields }] }], ...fields };
  await a.launch(chain);
  const everything = [tasks, tasks.tasks[0], tasks.tasks[1], chain, chain.chain[0], (chain.chain[1] as { parallel: Record<string, unknown>[] }).parallel[0]];
  for (const e of everything) assert.ok(!("size" in e) && !("risk" in e), JSON.stringify(e));
  // resume, a panel shadow and a malformed value on a non-launch: stripped whatever the outcome
  const resume = { action: "resume", id: "run-x", task: "go on", ...fields };
  await a.launch(resume);
  assert.ok(!("size" in resume) && !("risk" in resume));
  const shadow = { agent: "reviewer", task: "[panel-shadow:fake/x] review", size: "bad", risk: ["nope"] };
  await a.launch(shadow);
  assert.ok(!("size" in shadow) && !("risk" in shadow));
  const child = await r11Rig(t, { default: "standard" }, { child: true, config: { providers: providers() } });
  const kid = builder({ size: "bad", risk: ["guard"] });
  await child.launch(kid);
  assert.ok(!("size" in kid) && !("risk" in kid));
  assert.equal(sizing(child).length, 0);
});

test("a malformed size or risk refuses the foreman's launch with [sizing_invalid]", async (t) => {
  const a = await rig(t);
  for (const bad of [{ size: "big" }, { size: { files: "a.py" } }, { risk: ["speed"] }, { size: { files: ["a"], modules: -1 } }]) {
    const res = (await a.launch(builder(bad))).res;
    assert.equal(res?.block, true, JSON.stringify(bad));
    assert.match(res?.reason ?? "", /\[sizing_invalid\]/);
  }
  assert.ok(a.events("launch_refused").some((r) => r.reason === "sizing_invalid"));
  fs.mkdirSync(path.join(a.project, "dir"));
  assert.match((await a.launch(builder({ size: { files: ["dir"] } }))).res?.reason ?? "", /\[sizing_invalid\].*directories/);
});

test("a large file sends the builder to strong without a reason: rung_up reason sizing and a launch_sizing record", async (t) => {
  const a = await rig(t);
  big(a);
  const input = builder({ size: { files: ["big.py"] } });
  assert.equal((await a.launch(input)).res, undefined);
  assert.equal(input.model, "fake/strong");
  assert.deepEqual(a.events("rung_up").map((r) => [r.role, r.reason]), [["builder", "sizing"]]);
  const [s] = sizing(a);
  assert.deepEqual([s.role, s.rule, s.rung, s.base, s.files, s.lines, s.modules], ["builder", "large_file", "strong", "default", 1, 1700, 0]);
  assert.ok(!("note" in s));
});

test("a small launch stays default; no size and no risk is traced undeclared; a non-builder is traced only when it carried size", async (t) => {
  const a = await rig(t);
  const small = builder({ size: { files: ["new.py"] } });
  await a.launch(small);
  assert.equal(small.model, "fake/builder");
  const bare = builder();
  await a.launch(bare);
  assert.equal(bare.model, "fake/builder");
  await a.launch({ agent: "explorer", task: "look" });
  await a.launch({ agent: "explorer", task: "look", size: { files: ["new.py"] } });
  assert.deepEqual(sizing(a).map((r) => [r.role, r.rule, r.rung]), [["builder", "small", "default"], ["builder", "undeclared", "default"], ["explorer", "not_builder", "default"]]);
});

test("risk tags and modules: the rule ids and the strong rung", async (t) => {
  const a = await rig(t);
  const cases: [Record<string, unknown>, string][] = [
    [{ risk: ["guard"] }, "risk_strong"],
    [{ risk: ["parser"] }, "risk_strong"],
    [{ size: { files: ["a/x/1.py", "b/y/2.py", "c/z/3.py"] } }, "modules"],
  ];
  for (const [extra, rule] of cases) {
    const input = builder(extra);
    await a.launch(input);
    assert.equal(input.model, "fake/strong", rule);
    assert.equal(sizing(a).at(-1)?.rule, rule);
  }
});

test("an explicit default below the sizing rung is refused [sizing_below]; with a reason it wins and is traced override", async (t) => {
  const a = await rig(t);
  big(a);
  const refused = (await a.launch(builder({ model: "default", size: { files: ["big.py"] } }))).res;
  assert.equal(refused?.block, true);
  assert.match(refused?.reason ?? "", /\[sizing_below\].*large_file/);
  assert.ok(a.events("launch_refused").some((r) => r.reason === "sizing_below"));
  const raw = (await a.launch(builder({ model: "fake/builder", size: { files: ["big.py"] } }))).res;
  assert.match(raw?.reason ?? "", /\[sizing_below\]/, "the bottom-rung raw id counts as default");
  const ok = builder({ model: "default", reason: "one-line fix", size: { files: ["big.py"] } });
  assert.equal((await a.launch(ok)).res, undefined);
  assert.equal(ok.model, "fake/builder");
  assert.equal(sizing(a).at(-1)?.note, "explicit,override");
  // an explicit strong meets the sizing rung: the existing strong-needs-a-reason rule applies unchanged
  assert.match((await a.launch(builder({ model: "strong", size: { files: ["big.py"] } }))).res?.reason ?? "", /\[strong_no_reason\]/);
  const strongOk = builder({ model: "strong", reason: "large file", size: { files: ["big.py"] } });
  assert.equal((await a.launch(strongOk)).res, undefined);
  assert.equal(strongOk.model, "fake/strong");
  assert.equal(sizing(a).at(-1)?.note, "explicit");
});

test("without a strong rung nothing is refused: the launch keeps its model and says capped", async (t) => {
  const a = await rig(t, { strong: false });
  big(a);
  const input = builder({ model: "default", size: { files: ["big.py"] } });
  assert.equal((await a.launch(input)).res, undefined);
  assert.equal(input.model, "fake/builder");
  const plain = builder({ risk: ["security"] });
  assert.equal((await a.launch(plain)).res, undefined);
  assert.deepEqual(sizing(a).map((r) => [r.rule, r.rung, r.note]), [["large_file", "default", "capped"], ["risk_strong", "default", "capped"]]);
});

test("ranks: a lower-ranked raw id is below, a raw id at or above passes", async (t) => {
  const a = await rig(t, { ranks: RANKS });
  big(a);
  assert.match((await a.launch(builder({ model: "fake/explorer", size: { files: ["big.py"] } }))).res?.reason ?? "", /\[sizing_below\]/);
  const up = builder({ model: "fake/huge", size: { files: ["big.py"] } });
  assert.equal((await a.launch(up)).res, undefined);
  assert.equal(up.model, "fake/huge");
});

test("high pressure drops the sizing climb: climb_suppressed reason sizing, launch_sizing suppressed", async (t) => {
  const a = await rig(t);
  big(a);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  fs.mkdirSync(path.dirname(pressurePath(a.agentDir)), { recursive: true });
  fs.writeFileSync(pressurePath(a.agentDir), JSON.stringify({ level: "high", reasons: ["load"], at, host: {} }));
  const input = builder({ size: { files: ["big.py"] } });
  assert.equal((await a.launch(input)).res, undefined);
  assert.equal(input.model, "fake/builder");
  assert.deepEqual(a.events("climb_suppressed").map((r) => [r.level, r.reason]), [["high", "sizing"]]);
  assert.equal(sizing(a)[0].note, "suppressed");
  assert.deepEqual(a.events("rung_up"), []);
});

test("trivial tier on the builder path: a sizing strong launch escalates to standard", async (t) => {
  const a = await rig(t, { ceremony: { default: "trivial", required: { trivial: ["builder"] } } });
  big(a);
  const input = builder({ size: { files: ["big.py"] } });
  assert.equal((await a.launch(input)).res, undefined);
  assert.equal(input.model, "fake/strong");
  assert.ok(a.events("triage_escalated").some((r) => r.reason === "strong"), JSON.stringify(a.events("triage_escalated")));
  const b = await rig(t, { ceremony: { default: "trivial", required: { trivial: ["builder"] } } });
  const small = builder({ size: { files: ["new.py"] } });
  await b.launch(small);
  assert.deepEqual(b.events("triage_escalated"), []);
});

test("top: a design risk goes to the next rank above strong; a refused top falls back to strong, capped", async (t) => {
  const a = await rig(t, { ranks: RANKS });
  const input = builder({ risk: ["design"] });
  assert.equal((await a.launch(input)).res, undefined);
  assert.equal(input.model, "fake/huge");
  assert.deepEqual(a.events("rung_up").map((r) => [r.to, r.reason]), [["fake/huge", "sizing"]]);
  assert.deepEqual([sizing(a)[0].rule, sizing(a)[0].rung, sizing(a)[0].base], ["risk_top", "top", "default"]);
  // the next rank above strong equals the foreman's rank: the policy refuses it
  const same = await rig(t, { ranks: [{ match: "foreman*", tier: 0 }, { match: "huge", tier: 0 }, { match: "strong", tier: 2 }, { match: "*", tier: 3 }] });
  const fall = builder({ risk: ["design"] });
  assert.equal((await same.launch(fall)).res, undefined);
  assert.equal(fall.model, "fake/strong");
  assert.deepEqual([sizing(same)[0].rung, sizing(same)[0].note], ["strong", "capped"]);
  // no ranks and no topRung: strong, capped
  const none = await rig(t);
  const f2 = builder({ risk: ["design"] });
  await none.launch(f2);
  assert.deepEqual([f2.model, sizing(none)[0].note], ["fake/strong", "capped"]);
  // an explicit strong below top needs a reason
  assert.match((await a.launch(builder({ model: "strong", risk: ["design"] }))).res?.reason ?? "", /\[sizing_below\]/);
});

test("the probe line goes to the next item or pre-pr reviewer and is cleared by their PASS only", async (t) => {
  const a = await rig(t);
  const LINE = "[pi-foreman risk] guard, parser: probe for bypasses";
  const b = builder({ risk: ["guard", "parser"] });
  const bl = await a.launch(b);
  await a.started(bl.id, b, "run-b");
  a.end({ runId: "run-b", agent: "builder", status: "completed", success: true, summary: "built" });
  const plan = { agent: "reviewer", task: "[plan-review] check the plan" };
  const pl = await a.launch(plan);
  assert.ok(!plan.task.includes("[pi-foreman risk]"), "a plan review gets no probe line");
  await a.started(pl.id, plan, "run-plan");
  a.end({ runId: "run-plan", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n" });
  const item = { agent: "reviewer", task: "review items 1" };
  const il = await a.launch(item);
  assert.equal(il.res, undefined);
  assert.ok(item.task.includes(LINE), item.task);
  await a.started(il.id, item, "run-item");
  a.end({ runId: "run-item", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n1. PASS\n" });
  const next = { agent: "reviewer", task: "[second-opinion] review items 1" };
  await a.launch(next);
  assert.ok(!next.task.includes("[pi-foreman risk]"), "cleared by the item PASS");
});
