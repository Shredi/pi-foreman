// D31: the ledger a launch task names by path (.workflow/LEDGER-<topic>.md) drives its items block, roots block, PASS marks and
// hints; with no path (or an unusable one) the session-bound ledger stays in charge. Ledger A is the older one, B is bound (written last).
// A PASS mark or a hint lands only in the ledger its own entry named; when the result cannot be tied to its entry, nothing is marked.
// A launch's route is kept in a session entry, so a reload does not lose it; a run with no route entry is the bound ledger's.
// One rig for the file (every launch costs child processes): the reviewer launches come before the first PASS, which makes later ones repeats;
// the cases take their own item numbers; the reload is last because the rig cannot launch after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

const items = (name: string): string => `# ${name.toUpperCase()}\n\n${Array.from({ length: 12 }, (_, i) => `- [ ] ${i + 1}. ${name} item ${i + 1}`).join("\n")}\n- [ ] V. verify\n`;

/** The rig with ledger A (named by path only) and ledger B (bound: written through the foreman's write tool last). `entries` is the fake session file of the route entries, read back through getBranch, so `restart()` is a reload. */
async function ledgerWorld(t: Parameters<typeof r11Rig>[0]) {
  const entries: unknown[] = [];
  const base = reviewAllowOpts();
  const sessionManager = { getSessionId: () => process.env.PI_INTERCOM_SESSION_ID ?? "", getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries };
  const a = await r11Rig(t, { default: "standard" }, {
    ...base,
    ctx: { ...base.ctx, sessionManager },
    piExtra: { appendEntry: (customType: string, data: unknown) => void (customType === "pi-foreman-ledger-route" && entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) })) },
  });
  const fa = path.join(a.project, ".workflow", "LEDGER-a.md");
  const fb = path.join(a.project, ".workflow", "LEDGER-b.md");
  fs.writeFileSync(fa, items("alpha"));
  await a.toolDoing("write", { path: fb }, () => fs.writeFileSync(fb, items("beta")));
  return { a, fa, fb, entries };
}

const settle = (ms = 1000): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (f: string): string => fs.readFileSync(f, "utf8");
const done = (text: string, n: number): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(text);
const passOf = (n: number): string => `Overall verdict: PASS\n${n}. PASS covered\n`;
const noticeOf = (runId: string, n: number): string => `Background task completed: **reviewer**\n\n${passOf(n)}\nRetention-managed async directory: /tmp/x/${runId}\n`;
const taskOf = (e: Record<string, unknown>): string => String(e.task);

const hintsIn = async (file: string, needle: string): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    if (fs.readFileSync(file, "utf8").includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const pass = (n: number) => ({ agent: "reviewer", status: "completed", success: true, output: passOf(n) });

test("a launch task names its ledger by path", { skip }, async (t) => {
  const { a, fa, fb, entries } = await ledgerWorld(t);
  const launched = async (input: Record<string, unknown>, runId: string): Promise<void> => {
    const l = await a.launch(input);
    assert.equal(l.res, undefined, l.res?.reason);
    await a.started(l.id, input, runId);
  };

  await t.test("a tasks launch gets the block, roots block and Ledger file line per entry: A for the task naming it, the bound ledger B for the others", async () => {
    const input = { tasks: [{ agent: "builder", task: `build item 1 of ${fa}` }, { agent: "builder", task: "build item 1" }, { agent: "builder", task: `build item 2 of ${fb}` }] };
    const l = await a.launch(input);
    assert.equal(l.res, undefined, l.res?.reason);
    const [x, plain, y] = input.tasks.map(taskOf);
    assert.match(x, /1\. alpha item 1/);
    assert.doesNotMatch(x, /beta item/);
    assert.ok(x.includes("LEDGER-a.md"));
    assert.doesNotMatch(x, /LEDGER-b\.md/);
    assert.match(plain, /1\. beta item 1/);
    assert.match(plain, /LEDGER-b\.md/);
    assert.doesNotMatch(plain, /alpha item/);
    assert.match(y, /beta item 2/);
    assert.doesNotMatch(y, /alpha item/);
  });

  await t.test("a path outside .workflow/: the bound ledger plus a notice line", async () => {
    const stray = path.join(a.project, "elsewhere", ".workflow", "LEDGER-c.md");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, "# C\n\n- [ ] 1. gamma item\n");
    const r = { agent: "reviewer", task: `review item 1 of ${stray}` };
    const l = await a.launch(r);
    assert.equal(l.res, undefined, l.res?.reason);
    assert.match(taskOf(r), /ledger path not used: /);
    assert.match(taskOf(r), /beta item 1/);
    assert.doesNotMatch(taskOf(r), /gamma item/);
  });

  await t.test("a rung-up relaunch naming A takes its handoff lines from A", async () => {
    const first = { agent: "builder", task: `build item 1 of ${fa}` };
    await launched(first, "run-b1");
    a.end({ runId: "run-b1", agent: "builder", status: "completed", success: true, summary: "RUNG_UP: context\nDone: x" });
    const next = { agent: "builder", task: `go on with item 1 of ${fa}`, model: "strong", reason: "context ran out" };
    const n = await a.launch(next);
    assert.equal(n.res, undefined, n.res?.reason);
    assert.match(taskOf(next), /alpha item 1/);
    assert.doesNotMatch(taskOf(next), /beta item/);
  });

  await t.test("hints cite only the items of the entries that named each ledger", async () => {
    await launched({ tasks: [{ agent: "builder", task: `build item 8 of ${fa}` }, { agent: "builder", task: `build item 9 of ${fb}` }] }, "run-h1");
    await settle(400);
    const A = read(fa).split("\n");
    const B = read(fb).split("\n");
    const under = (lines: string[], n: number): boolean => {
      const at = lines.findIndex((x) => x.includes(`${n}. `) && x.includes("item"));
      return at >= 0 && (lines[at + 1] ?? "").includes("run-h1");
    };
    assert.ok(under(A, 8) && !under(A, 9), A.join("\n"));
    assert.ok(under(B, 9) && !under(B, 8), B.join("\n"));
    assert.equal(A.filter((x) => x.includes("run-h1")).length, 1);
    assert.equal(B.filter((x) => x.includes("run-h1")).length, 1);
  });

  await t.test("a launch hint and a FAIL verdict hint with A named land in A, not in B", async () => {
    await launched({ agent: "reviewer", task: `review item 1 of ${fa}` }, "run-r1");
    assert.ok(await hintsIn(fa, "reviewer launched (run run-r1"), read(fa));
    a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: FAIL\n1. broken\n" });
    assert.ok(await hintsIn(fa, "review FAIL (run run-r1"), read(fa));
    await settle(150);
    assert.doesNotMatch(read(fb), /run run-r1/);
  });

  await t.test("a resumed reviewer run keeps the route of the run it resumes (its PASS comes with the notices below)", async () => {
    await launched({ agent: "reviewer", task: `review item 10 of ${fa}` }, "run-rs1");
    a.end({ runId: "run-rs1", agent: "reviewer", status: "timed-out", success: false, output: "ran out of time" });
    const resume = { action: "resume", id: "run-rs1", message: "finish the review" };
    const l = await a.launch(resume);
    assert.equal(l.res, undefined, l.res?.reason);
    await a.started(l.id, resume, "run-rs2");
    assert.ok((entries as { data: { run: string; paths: unknown[] } }[]).some((e) => e.data.run === "run-rs2" && e.data.paths[0] === fa), "the resumed run's route is persisted");
  });

  await t.test("PASS marks: each result marks the ledger its own entry named; a second opinion marks nothing; the repeat after a PASS is refused", async () => {
    // a reviewer launch is a single launch: each result of the old groups is a run of its own (item number, ledger it names)
    const singles: [string, string, number][] = [["run-c1", `review item 1 of ${fa}`, 1], ["run-c2", `review item 2 of ${fb}`, 2], ["run-m1", `[second-opinion] look at ${fb}`, 4], ["run-m2", "review item 5", 5], ["run-m3", `review item 6 of ${fa}`, 6], ["run-m4", `review item 3 of ${fa}`, 3], ["run-m5", `review item 7 of ${fb}`, 7]];
    const inputs = singles.map(([, task]) => ({ agent: "reviewer", task }));
    for (const [i, [runId]] of singles.entries()) await launched(inputs[i], runId);
    assert.ok(taskOf(inputs[4]).includes(`Ledger file (absolute path, readable from any directory): ${fs.realpathSync(fa)}`) || taskOf(inputs[4]).includes(fa), taskOf(inputs[4]));
    // the runs the notices below are about: launched before the first PASS, as a PASS makes a later reviewer launch a repeat
    await launched({ agent: "reviewer", task: `review item 8 of ${fa}` }, "run-n2");
    await launched({ agent: "reviewer", task: `review item 9 of ${fa}` }, "run-l1");
    await launched({ agent: "reviewer", task: "review item 11" }, "run-u1");
    const routed = (entries as { data: { run: string } }[]).map((e) => e.data.run);
    assert.ok(routed.includes("run-n2") && routed.includes("run-l1"), "a launch that named a ledger appended its route entry");
    // plan 2.2: every review launch appends a route entry (the notice after a reload needs the launch id and occasion); one that named none has no path
    const unnamed = (entries as { data: { run: string; paths: unknown[] } }[]).find((e) => e.data.run === "run-u1");
    assert.deepEqual(unnamed?.data.paths, [null], "a launch that named none appended an entry without a path");

    for (const [runId, , n] of singles) a.end({ runId, agent: "reviewer", status: "completed", success: true, results: [pass(n)] });
    await settle(1500);
    const A = read(fa);
    const B = read(fb);
    assert.ok([1, 3, 6].every((n) => done(A, n)) && [2, 4, 5, 7].every((n) => !done(A, n)), A);
    assert.ok([2, 5, 7].every((n) => done(B, n)) && [1, 3, 4, 6].every((n) => !done(B, n)), B);

    const again = await a.launch({ agent: "reviewer", task: `review item 12 of ${fa}` });
    assert.equal(again.res?.block, true);
    assert.match(again.res?.reason ?? "", /nothing changed/);
  });

  await t.test("notices, before and after a reload: the ledger the run named, else the bound ledger", async () => {
    // the resumed child keeps the first launch's record folder: its call writes there
    assert.ok(a.record("run-rs1", { verdict: "pass", items: [{ id: 10, result: "pass" }] }));
    a.end({ runId: "run-rs2", agent: "reviewer", status: "completed", success: true, results: [pass(10)] });
    await settle(1000);
    assert.ok(done(read(fa), 10) && !done(read(fb), 10), "a resumed run's PASS marks the ledger the resumed run named: " + read(fa));
    assert.ok(await hintsIn(fa, "run-rs2"), "its hints land in A");
    assert.doesNotMatch(read(fb), /run-rs2/);
    // the reviewers' calls: the records wait in the launch folders until a notice (or a run end) reads them
    for (const [runId, n] of [["run-n2", 8], ["run-l1", 9], ["run-u1", 11]] as const) assert.ok(a.record(runId, { verdict: "pass", items: [{ id: n, result: "pass" }] }));
    await a.notice(noticeOf("run-n2", 8));
    await settle();
    assert.ok(done(read(fa), 8) && !done(read(fb), 8), "a named run's notice marks A");
    await a.restart(); // a reload: the routes come back from the entries, the unnamed run has none
    await a.notice(noticeOf("run-l1", 9));
    await a.notice(noticeOf("run-u1", 11));
    await settle();
    assert.ok(done(read(fa), 9) && !done(read(fb), 9), "after a reload a run that named A still marks A: " + read(fa));
    assert.ok(done(read(fb), 11) && !done(read(fa), 11), "after a reload an unnamed run marks the bound ledger");
  });
});
