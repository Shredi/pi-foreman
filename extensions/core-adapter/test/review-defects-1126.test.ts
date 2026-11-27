// D189a (a `.workflow/`-only or empty builder run is no revision), D203 (mark V and the reviewer launch are never both refused), D185 (an invalid plan verdict counts no round).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { commentOnlySince } from "../commentonly.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { world as rworld } from "./_r46world.ts";
import { gatesRevise, gatesVerdict, goneDropped, standsFor, vAccepts, type ReviewGates } from "../reviewgates.ts";
import type { World } from "./_hsrig.ts";
import { build, end, launch, settle, setup, tick, worktree } from "./_hsrig.ts";

const lastEntry = (w: World) => w.ceremonyEntries().at(-1)!.data as { gate?: Record<string, unknown> };
/** Waits until the newest ceremony entry holds a pass mark (it lands after the git reads). */
async function marked(w: World): Promise<void> {
  const stop = Date.now() + 8000;
  while (Date.now() < stop && Object.keys((lastEntry(w).gate?.passMarks ?? {}) as object).length < 1) await tick(50);
  assert.ok(Object.keys((lastEntry(w).gate?.passMarks ?? {}) as object).length >= 1, "pass mark persisted");
}
/** The checkout the PASS mark was taken in (the builder works there). */
const markCwd = (w: World): string => (Object.values((lastEntry(w).gate?.passMarks ?? {}) as Record<string, { cwd: string }>)[0]).cwd;
const pass = (g: ReviewGates, k: string, at: number): ReviewGates => gatesVerdict(g, [k], ["pass"], at, `r${at}`);
const fail = (g: ReviewGates, k: string, at: number): ReviewGates => gatesVerdict(g, [k], ["fail"], at, `r${at}`);
/** The two checks of D203 over the live gates (`exists`): [mark V refused, repeat launch in `k` refused]. */
const checks = (g: ReviewGates, k: string, exists: (d: string) => boolean = () => true): [boolean, boolean] => {
  const live = goneDropped(g, exists).gates;
  return [!vAccepts(live), standsFor(g, [k]) && vAccepts(live)];
};

test("D203: nothing changed after a PASS: the launch is refused, V accepted", () => {
  assert.deepEqual(checks(pass({}, "/a", 1), "/a"), [false, true]);
});

test("D203: a revision after the PASS: V is still accepted (as before), the launch is allowed (the checkout no longer stands)", () => {
  assert.deepEqual(checks(gatesRevise(pass({}, "/a", 1), "/a"), "/a"), [false, false]);
});

test("D203: a second checkout with a FAIL newer than the standing PASS: V refused, the launch in the standing checkout allowed", () => {
  const g = fail(pass(pass({}, "/a", 1), "/b", 2), "/b", 3);
  assert.deepEqual(checks(g, "/a"), [true, false]);
});

test("D203: a deleted checkout with a later FAIL, with or without a builder entry, is dropped: V accepted, a launch in the standing checkout refused as a repeat", () => {
  const g = fail(pass({}, "/a", 1), "/b", 3);
  assert.deepEqual(checks(g, "/a", (d) => d !== "/b"), [false, true]);
  assert.deepEqual(checks(g, "/a"), [true, false], "while it exists V is refused and the launch allowed");
});

test("D203: generated states never refuse both", () => {
  const evs = ["pass", "fail", "rev"] as const;
  let n = 0;
  const go = (g: ReviewGates, depth: number): void => {
    for (const k of ["/a", "/b"]) {
      for (const gone of [false, true]) {
        const [v, l] = checks(g, k, (d) => !(gone && d === "/b"));
        assert.ok(!(v && l), JSON.stringify(g));
        n++;
      }
    }
    if (depth === 0) return;
    for (const k of ["/a", "/b"]) for (const e of evs) go(e === "pass" ? pass(g, k, depth) : e === "fail" ? fail(g, k, depth) : gatesRevise(g, k), depth - 1);
  };
  go({}, 4);
  assert.ok(n > 1000);
});

test("D189a end to end: a builder run that changed only .workflow/ withdraws the revision, the finish passes", async (t) => {
  const { a, w } = await setup(t, { world: { realSnapshot: true } });
  await build(a);
  await marked(w);
  await tick(300);
  const ta = await launch(a, "builder", "write notes");
  assert.equal(ta.blocked, null);
  const cwd = markCwd(w);
  fs.mkdirSync(path.join(cwd, ".workflow"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".workflow", "notes.txt"), "words\n");
  await end(a, ta, "builder", "done");
  await tick(300);
  assert.equal(await settle(a), "");
});

test("D189a end to end: a builder run that changed nothing withdraws the revision", async (t) => {
  const { a, w } = await setup(t, { world: { realSnapshot: true } });
  await build(a);
  await marked(w);
  await tick(300);
  const ta = await launch(a, "builder", "look around");
  assert.equal(ta.blocked, null);
  await end(a, ta, "builder", "done");
  await tick(300);
  assert.equal(await settle(a), "");
});

test("D189a end to end: a code change next to a .workflow/ change keeps the revision", async (t) => {
  const { a, w } = await setup(t, { world: { realSnapshot: true } });
  await build(a);
  await marked(w);
  await tick(300);
  const ta = await launch(a, "builder", "change code");
  const cwd = markCwd(w);
  fs.mkdirSync(path.join(cwd, ".workflow"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".workflow", "notes.txt"), "words\n");
  fs.writeFileSync(path.join(cwd, "code.ts"), "export const x = 1;\n");
  await end(a, ta, "builder", "done");
  await tick(300);
  assert.match(await settle(a), /review/i);
});

test("D203 end to end: a FAIL in B after a PASS in A: a reviewer launch in A is allowed", async (t) => {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  await build(s.a);
  const rb = await launch(s.a, "reviewer", "[pre-pr] review the branch", { cwd: b });
  await end(s.a, rb, "reviewer", "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL", b);
  const again = await launch(s.a, "reviewer", "[pre-pr] review the branch");
  assert.equal(again.blocked, null, String(again.blocked));
});

test("D185 end to end: a plan-review run end with no valid verdict counts no round and sets no [review_loop]; the next two equal FAILs are rounds 1 and 2", async (t) => {
  const w = rworld(t);
  const a = await w.adapter("startup");
  const events = async (name: string) => (await w.traceEvents()).filter((e) => e.event === name).length;
  const waitFor = async (name: string, want: number): Promise<void> => {
    const stop = Date.now() + 10_000;
    while ((await events(name)) < want && Date.now() < stop) await tick(25);
    assert.equal(await events(name), want, `${name} x${want}`);
  };
  const FAIL = "1. FAIL plan.md:1: the scope is unclear\nOverall verdict: FAIL";
  const run = async (report: string): Promise<string | null> => {
    const r = await a.reviewLaunch();
    if (r.blocked) return r.blocked;
    a.endRun(r.id, report);
    return null;
  };
  assert.equal(await run("garbage, no verdict at all"), null);
  await tick(500);
  assert.equal(await events("plan_review"), 0, "the invalid verdict is dropped");
  assert.equal(await events("review_loop"), 0);
  assert.equal(await run(FAIL), null);
  await waitFor("plan_review", 1);
  assert.equal(await run("still garbage"), null);
  await tick(500);
  assert.equal(await events("plan_review"), 1, "no second round from the invalid verdict");
  assert.equal(await events("review_loop"), 0, "one FAIL round: no loop stop");
  assert.equal(await run(FAIL), null);
  await waitFor("plan_review", 2);
  await waitFor("review_loop", 1);
  assert.match((await a.reviewLaunch()).blocked ?? "", /\[review_loop\]/, "the second equal FAIL round stops the loop, as if the invalid run had not happened");
});

test("D189a: an owner edit under .workflow/ after a PASS keeps the standing PASS", async (t) => {
  const { a, w } = await setup(t, { world: { realSnapshot: true } });
  await build(a, {}, w.project);
  await marked(w);
  await tick(300);
  const cwd = markCwd(w);
  assert.equal(fs.realpathSync.native(cwd), fs.realpathSync.native(w.project), "the PASS stands in the session's own checkout");
  const notes = path.join(cwd, ".workflow", "owner-notes.md");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, "first\n");
  assert.equal((await a.call("write", { path: notes, content: "first\n" })).block, undefined);
  await tick(300);
  assert.equal(await settle(a), "", "a .workflow/ write is no revision");
});

test("D189a: an unreadable diff keeps the revision (commentOnlySince is null, not the empty list)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-d189a-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    assert.equal(await commentOnlySince({ cwd: dir, tree: "0".repeat(40) }), null);
    assert.equal(await commentOnlySince({ cwd: path.join(dir, "missing"), tree: "0".repeat(40) }), null);
  } finally {
    rmTestTmp(dir);
  }
});
