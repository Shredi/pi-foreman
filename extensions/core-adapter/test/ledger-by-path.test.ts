// D31: the ledger a launch task names by path (.workflow/LEDGER-<topic>.md) drives its items block, roots block, PASS marks and
// hints; with no path (or an unusable one) the session-bound ledger stays in charge. Ledger A is the older one, B is bound (written last).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const A_TEXT = "# A\n\n- [ ] 1. alpha item one\n- [ ] 2. alpha item two\n- [ ] V. verify\n";
const B_TEXT = "# B\n\n- [ ] 1. beta item one\n- [ ] 2. beta item two\n- [ ] V. verify\n";

async function world(t: Parameters<typeof r11Rig>[0]): Promise<{ a: Rig; fa: string; fb: string }> {
  const a = await r11Rig(t, { default: "standard" }, reviewAllowOpts());
  const fa = path.join(a.project, ".workflow", "LEDGER-a.md");
  const fb = path.join(a.project, ".workflow", "LEDGER-b.md");
  await a.toolDoing("write", { path: fa }, () => fs.writeFileSync(fa, A_TEXT));
  await a.toolDoing("write", { path: fb }, () => fs.writeFileSync(fb, B_TEXT));
  return { a, fa, fb };
}

const taskOf = (e: Record<string, unknown>): string => String(e.task);
const hintsIn = async (file: string, needle: string): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    if (fs.readFileSync(file, "utf8").includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a builder task naming the older ledger gets its block, roots block and Ledger file line from A", { skip }, async (t) => {
  const { a, fa } = await world(t);
  const b = { agent: "builder", task: `build item 1 of ${fa}` };
  const l = await a.launch(b);
  assert.equal(l.res, undefined, l.res?.reason);
  assert.match(taskOf(b), /1\. alpha item one/);
  assert.doesNotMatch(taskOf(b), /beta item/);
  assert.ok(taskOf(b).includes(`LEDGER-a.md`));
  assert.doesNotMatch(taskOf(b), /LEDGER-b\.md/);
});

test("a reviewer task naming A shows A's Ledger file line; a PASS marks A's item and leaves B", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const r = { agent: "reviewer", task: `review item 1 of ${fa}` };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  assert.ok(taskOf(r).includes(`Ledger file (absolute path, readable from any directory): ${fs.realpathSync(fa)}`) || taskOf(r).includes(fa), taskOf(r));
  assert.match(taskOf(r), /alpha item one/);
  await a.started(l.id, r, "run-r1");
  a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n1. PASS covered\n" });
  await settle(800);
  assert.match(fs.readFileSync(fa, "utf8"), /- \[x\] 1\. alpha item one/);
  assert.match(fs.readFileSync(fb, "utf8"), /- \[ \] 1\. beta item one/);
});

test("no path: the bound ledger B, as today", { skip }, async (t) => {
  const { a } = await world(t);
  const b = { agent: "builder", task: "build item 1" };
  const l = await a.launch(b);
  assert.equal(l.res, undefined, l.res?.reason);
  assert.match(taskOf(b), /1\. beta item one/);
  assert.match(taskOf(b), /LEDGER-b\.md/);
});

test("a path outside .workflow/: the bound ledger plus a notice line", { skip }, async (t) => {
  const { a } = await world(t);
  const stray = path.join(a.project, "elsewhere", ".workflow", "LEDGER-c.md");
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, "# C\n\n- [ ] 1. gamma item\n");
  const r = { agent: "reviewer", task: `review item 1 of ${stray}` };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  assert.match(taskOf(r), /ledger path not used: /);
  assert.match(taskOf(r), /beta item one/);
  assert.doesNotMatch(taskOf(r), /gamma item/);
});

test("a second reviewer after a PASS with nothing changed, task naming A, is refused as a repeat", { skip }, async (t) => {
  const { a, fa } = await world(t);
  const r = { agent: "reviewer", task: `review item 1 of ${fa}` };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, r, "run-r1");
  a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n1. PASS covered\n" });
  await settle(800);
  const again = await a.launch({ agent: "reviewer", task: `review item 2 of ${fa}` });
  assert.equal(again.res?.block, true);
  assert.match(again.res?.reason ?? "", /nothing changed/);
});

test("a launch hint and a FAIL verdict hint with A named land in A, not in B", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const r = { agent: "reviewer", task: `review item 1 of ${fa}` };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, r, "run-r1");
  assert.ok(await hintsIn(fa, "reviewer launched (run run-r1"), fs.readFileSync(fa, "utf8"));
  a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: FAIL\n1. broken\n" });
  assert.ok(await hintsIn(fa, "review FAIL (run run-r1"), fs.readFileSync(fa, "utf8"));
  await settle();
  assert.doesNotMatch(fs.readFileSync(fb, "utf8"), /run run-r1/);
});

test("a rung-up relaunch naming A takes its handoff lines from A", { skip }, async (t) => {
  const { a, fa } = await world(t);
  const first = { agent: "builder", task: `build item 1 of ${fa}` };
  const l = await a.launch(first);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, first, "run-b1");
  a.end({ runId: "run-b1", agent: "builder", status: "completed", success: true, summary: "RUNG_UP: context\nDone: x" });
  const next = { agent: "builder", task: `go on with item 1 of ${fa}`, model: "strong", reason: "context ran out" };
  const n = await a.launch(next);
  assert.equal(n.res, undefined, n.res?.reason);
  assert.match(taskOf(next), /alpha item one/);
  assert.doesNotMatch(taskOf(next), /beta item/);
});

test("a tasks launch gets the right block per entry", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const input = { tasks: [{ agent: "builder", task: `build item 1 of ${fa}` }, { agent: "builder", task: `build item 2 of ${fb}` }] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  const [x, y] = input.tasks.map(taskOf);
  assert.match(x, /alpha item one/);
  assert.doesNotMatch(x, /beta item/);
  assert.match(y, /beta item two/);
  assert.doesNotMatch(y, /alpha item/);
});

test("a tasks launch: each reviewer PASS marks the ledger its own entry named", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const input = { tasks: [{ agent: "reviewer", task: `review item 1 of ${fa}` }, { agent: "reviewer", task: `review item 2 of ${fb}` }] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "run-t1");
  a.end({
    runId: "run-t1",
    agent: "reviewer",
    status: "completed",
    success: true,
    results: [
      { agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n1. PASS covered\n" },
      { agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n2. PASS covered\n" },
    ],
  });
  await settle(1000);
  const A = fs.readFileSync(fa, "utf8");
  const B = fs.readFileSync(fb, "utf8");
  assert.match(A, /- \[x\] 1\. alpha item one/);
  assert.match(A, /- \[ \] 2\. alpha item two/);
  assert.match(B, /- \[x\] 2\. beta item two/);
  assert.match(B, /- \[ \] 1\. beta item one/);
});
