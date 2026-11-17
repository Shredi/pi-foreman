// D31 routing: a PASS mark or a hint lands only in the ledger its own entry named; when the result cannot be tied to its entry, nothing is marked.
// Ledger A is the older one, B is bound (written last).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

const A_TEXT = "# A\n\n- [ ] 1. alpha item one\n- [ ] 2. alpha item two\n- [ ] V. verify\n";
const B_TEXT = "# B\n\n- [ ] 1. beta item one\n- [ ] 2. beta item two\n- [ ] V. verify\n";

async function world(t: Parameters<typeof r11Rig>[0]) {
  const a = await r11Rig(t, { default: "standard" }, reviewAllowOpts());
  const fa = path.join(a.project, ".workflow", "LEDGER-a.md");
  const fb = path.join(a.project, ".workflow", "LEDGER-b.md");
  await a.toolDoing("write", { path: fa }, () => fs.writeFileSync(fa, A_TEXT));
  await a.toolDoing("write", { path: fb }, () => fs.writeFileSync(fb, B_TEXT));
  return { a, fa, fb };
}

const pass = (n: number) => ({ agent: "reviewer", status: "completed", success: true, output: `Overall verdict: PASS\n${n}. PASS covered\n` });
const settle = (ms = 1000): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (f: string): string => fs.readFileSync(f, "utf8");
const done = (text: string, n: number): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(text);

test("a chain with a parallel group naming A and B: each mark lands in its own ledger", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const input = { chain: [{ parallel: [{ agent: "reviewer", task: `review item 1 of ${fa}` }, { agent: "reviewer", task: `review item 2 of ${fb}` }] }] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "run-c1");
  a.end({ runId: "run-c1", agent: "reviewer", status: "completed", success: true, results: [pass(1), pass(2)] });
  await settle();
  const A = read(fa);
  const B = read(fb);
  assert.ok(done(A, 1) && !done(A, 2), A);
  assert.ok(done(B, 2) && !done(B, 1), B);
});

test("a [second-opinion] result before a counting one naming A: the mark is in A", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const input = { tasks: [{ agent: "reviewer", task: `[second-opinion] look at ${fb}` }, { agent: "reviewer", task: `review item 1 of ${fa}` }] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "run-s1");
  a.end({ runId: "run-s1", agent: "reviewer", status: "completed", success: true, results: [pass(2), pass(1)] });
  await settle();
  const A = read(fa);
  const B = read(fb);
  assert.ok(done(A, 1), A);
  assert.ok(!done(B, 1) && !done(B, 2), B);
});

test("the run map lost (a reload): the result's own task names the ledger, else nothing is marked", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const r = { agent: "reviewer", task: `review item 1 of ${fa}` };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, r, "run-l1");
  await a.restart();
  a.end({ runId: "run-l1", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS\n1. PASS covered\n" });
  await settle();
  assert.ok(!done(read(fb), 1), read(fb));
  assert.ok(!done(read(fa), 1), read(fa));

  const r2 = { agent: "reviewer", task: `review item 2 of ${fa} again` };
  const l2 = await a.launch(r2);
  await a.started(l2.id, r2, "run-l2");
  await a.restart();
  a.end({ runId: "run-l2", agent: "reviewer", status: "completed", success: true, task: `review item 2 of ${fa}`, output: "Overall verdict: PASS\n2. PASS covered\n" });
  await settle();
  assert.ok(!done(read(fb), 2), read(fb));
});

test("mixed entries: the unnamed one marks the bound ledger, the named one its own", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const input = { tasks: [{ agent: "reviewer", task: "review item 1" }, { agent: "reviewer", task: `review item 2 of ${fa}` }] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "run-m1");
  a.end({ runId: "run-m1", agent: "reviewer", status: "completed", success: true, results: [pass(1), pass(2)] });
  await settle();
  const A = read(fa);
  const B = read(fb);
  assert.ok(done(B, 1) && !done(B, 2), B);
  assert.ok(done(A, 2) && !done(A, 1), A);
});

test("hints cite only the items of the entries that named each ledger", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const input = { tasks: [{ agent: "builder", task: `build item 1 of ${fa}` }, { agent: "builder", task: `build item 2 of ${fb}` }] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "run-h1");
  await settle(400);
  const hintLines = (text: string): string[] => text.split("\n").filter((x) => x.includes("run-h1"));
  const A = read(fa).split("\n");
  const B = read(fb).split("\n");
  const under = (lines: string[], n: number): boolean => {
    const at = lines.findIndex((x) => x.includes(`${n}. `) && x.includes("item"));
    return at >= 0 && (lines[at + 1] ?? "").includes("run-h1");
  };
  assert.ok(under(A, 1) && !under(A, 2), A.join("\n"));
  assert.ok(under(B, 2) && !under(B, 1), B.join("\n"));
  assert.equal(hintLines(A.join("\n")).length, 1);
  assert.equal(hintLines(B.join("\n")).length, 1);
});
