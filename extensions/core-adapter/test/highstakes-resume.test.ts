// D144: a high-stakes run that ended without a verdict may be resumed while the head and tree of its checkout are unchanged and its context has room;
// a nearly full one falls back to a fresh run that gets the incomplete run's report as a handoff, and both count as one high-stakes review.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { used, hsResumeRefusal, emptyState, type HsState } from "../highstakes.ts";
import { writeContextUse } from "../verdict.ts";
import type { RecSpec } from "./_verdict-rig.ts";
import { bindingOf } from "./_verdict-rig.ts";
import { subagentActionCheck } from "../actions.ts";
import { MODEL, build, commitIn, git, hsRun, launch, persisted, pr, setup, tick, traces, worktree, type Rig, type World } from "./_hsrig.ts";

const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const INCOMPLETE: RecSpec = { verdict: "incomplete", reason: "checks left: 3, 4" };
const PASS: RecSpec = { verdict: "pass" };
const hsOf = (w: World) => (w.ceremonyEntries().at(-1)?.data as { highStakes?: { runs?: { verdict: string; head: string | null; cwd: string }[]; incomplete?: { runId: string; head: string | null; model?: string }; runIds?: { id: string; from?: string }[] } } | undefined)?.highStakes;

/** The checkout the incomplete run was launched in: a bare launch runs in the session folder (D118), not in the project. */
const runCheckout = (w: World): string => (hsOf(w)?.incomplete as { cwd?: string } | undefined)?.cwd ?? w.project;

async function standing(t: Parameters<typeof setup>[0], world?: Record<string, unknown>) {
  const r = await setup(t, { onMain: true, ...(world ? { world } : {}) });
  r.w.state.answer = "allow once";
  await build(r.a, sized(["design"]));
  return r;
}

/** A high-stakes launch (in `cwd`) that ends with no verdict; resolves once its state holds the incomplete run. */
async function incompleteRun(a: Rig, w: World, cwd?: string) {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change", cwd ? { cwd } : {});
  assert.equal(s.blocked, null, String(s.blocked));
  a.endRunRecord(s.id, INCOMPLETE);
  await persisted(w, (hs) => hs?.incomplete?.runId === `run-${s.id}`);
  return s;
}

/** The resume of `first` (as the foreman writes it); its record goes into the first launch's folder (the resumed child keeps that binding). */
const resume = (a: Rig, first: { id: string }) => launch(a, "reviewer", "continue", { action: "resume", id: `run-${first.id}` });
const endResumed = (a: Rig, first: { id: string }, r: { id: string }, spec: RecSpec) => {
  a.record(first.id, spec);
  return a.endRunAs(r.id, "reviewer", "report");
};

test("an incomplete high-stakes run resumes while nothing changed; its verdict is recorded as high-stakes, and the run is no longer incomplete", async (t) => {
  const { w, a } = await standing(t);
  const first = await incompleteRun(a, w);
  assert.equal((await traces(w, "high_stakes")).filter((e) => e.kind === "incomplete").length, 1);
  const r = await resume(a, first);
  assert.equal(r.blocked, null, String(r.blocked)); // the model is the high-stakes one, not the reviewer role map's
  assert.deepEqual((await traces(w, "review_high_stakes_refused")).map((e) => e.reason), []);
  await endResumed(a, first, r, PASS);
  const stop = Date.now() + 10_000;
  while ((await traces(w, "review_high_stakes")).length === 0 && Date.now() < stop) await tick(50);
  assert.equal((await traces(w, "review_high_stakes")).at(-1)?.verdict, "pass");
  await persisted(w, (hs) => hs?.runs?.length === 1 && hs.incomplete === undefined);
  assert.equal(hsOf(w)?.runIds?.find((x) => x.id === `run-${r.id}`)?.from, `run-${first.id}`, "the resumed run is linked to the incomplete one");
  assert.equal((await traces(w, "review_recorded")).length, 1, "no normal review record: only the build's PASS");
});

test("a resumed run that ends without a verdict again is the incomplete one, and resumes once more", async (t) => {
  const { w, a } = await standing(t);
  const first = await incompleteRun(a, w);
  const r = await resume(a, first);
  assert.equal(r.blocked, null, String(r.blocked));
  a.endRunRecord(first.id, INCOMPLETE);
  a.record(first.id, INCOMPLETE);
  await a.endRunAs(r.id, "reviewer", "report");
  await persisted(w, (hs) => hs?.incomplete?.runId === `run-${r.id}`);
  const again = await resume(a, r);
  assert.equal(again.blocked, null, String(again.blocked));
});

test("the incomplete run survives a reload and still resumes", async (t) => {
  const { w, a } = await standing(t);
  const first = await incompleteRun(a, w);
  await a.down();
  const b = await w.adapter("reload");
  await tick(50);
  const r = await resume(b, first);
  assert.equal(r.blocked, null, String(r.blocked));
});

test("a run incomplete in a checkout that is not the session's resumes there: its verdict keeps that checkout's head", async (t) => {
  const { w, a } = await standing(t);
  const wt = worktree(w, "other");
  commitIn(wt, "src/a/y.ts");
  await build(a, {}, wt); // a normal PASS stands in that checkout
  const first = await incompleteRun(a, w, wt);
  const r = await resume(a, first);
  assert.equal(r.blocked, null, String(r.blocked));
  await endResumed(a, first, r, PASS);
  await persisted(w, (hs) => hs?.runs?.length === 1);
  assert.equal(hsOf(w)?.runs?.[0]?.head, git(wt, "rev-parse", "HEAD"));
  assert.equal(hsOf(w)?.runs?.[0]?.cwd, fs.realpathSync.native(wt));
});

test("a resume is refused when the head moved, the tree changed, the run had a verdict, or a high-stakes run is still running", async (t) => {
  const moved = await standing(t);
  const m = await incompleteRun(moved.a, moved.w);
  commitIn(runCheckout(moved.w), "src/a/z.ts");
  const mr = await resume(moved.a, m);
  assert.match(mr.blocked ?? "", /\[high_stakes_resume\].*head moved/);
  assert.equal(hsOf(moved.w)?.incomplete, undefined, "a head change ends the incomplete run");

  const tree = await standing(t, { realSnapshot: true });
  const tr = await incompleteRun(tree.a, tree.w);
  fs.writeFileSync(`${runCheckout(tree.w)}/src-dirty.txt`, "dirty\n");
  const trr = await resume(tree.a, tr);
  assert.match(trr.blocked ?? "", /\[high_stakes_resume\].*work tree changed/);

  const done = await standing(t);
  const verdict = await hsRun(done.a, "FAIL");
  const dr = await resume(done.a, verdict);
  assert.match(dr.blocked ?? "", /\[high_stakes_resume\].*not the incomplete high-stakes run/);

  const live = await standing(t);
  const running = await launch(live.a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(running.blocked, null);
  const lr = await resume(live.a, running);
  assert.match(lr.blocked ?? "", /\[high_stakes_resume\].*still running/);
});

test("context nearly full: the resume is refused with the fallback; a fresh run gets the report as a handoff, and the pair counts as one review", async (t) => {
  const { w, a } = await standing(t);
  const first = await incompleteRun(a, w);
  const dir = bindingOf(first.input)?.verdictDir ?? "";
  assert.ok(dir && fs.existsSync(dir), "the launch has a record folder");
  writeContextUse(dir, { tokens: 70_000, contextWindow: 100_000 });
  const refused = await resume(a, first);
  assert.match(refused.blocked ?? "", /\[high_stakes_resume_context\]/);
  assert.deepEqual((await traces(w, "review_high_stakes_refused")).map((e) => e.reason), ["high_stakes_resume_context"]);
  const fresh = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(fresh.blocked, null, String(fresh.blocked));
  assert.match(String(fresh.input.task), new RegExp(`run-${first.id}`), "the handoff names the incomplete run");
  a.record(fresh.id, { verdict: "fail", findings: [{ kind: "defect", text: "broken", file: "src/a/x.ts", line: 1 }] });
  await a.endRunAs(fresh.id, "reviewer", "report");
  await persisted(w, (hs) => hs?.runs?.length === 1 && hs.incomplete === undefined);
  assert.equal(hsOf(w)?.runIds?.find((x) => x.id === `run-${fresh.id}`)?.from, `run-${first.id}`, "the fresh run is linked");
});

test("below the context threshold, or with no usage file, a resume is allowed", async (t) => {
  const { w, a } = await standing(t);
  const first = await incompleteRun(a, w);
  writeContextUse(bindingOf(first.input)?.verdictDir ?? "", { tokens: 50_000, contextWindow: 100_000 });
  const r = await resume(a, first);
  assert.equal(r.blocked, null, String(r.blocked));
});

const st = (over: Partial<HsState> = {}): HsState => ({ ...emptyState(), ...over });
const inc = { runId: "r1", cwd: "/c", head: "h", tree: "t", reportPath: null, at: 1 };
const base = { target: "r1", state: st({ incomplete: inc }), running: false, head: "h", tree: "t", usage: null };

test("hsResumeRefusal: allowed for the incomplete run only, in the order running, identity, head, tree, context", () => {
  assert.equal(hsResumeRefusal(base), null);
  assert.match(hsResumeRefusal({ ...base, running: true })?.text ?? "", /still running/);
  assert.match(hsResumeRefusal({ ...base, target: "other" })?.text ?? "", /not the incomplete high-stakes run/);
  assert.match(hsResumeRefusal({ ...base, state: st() })?.text ?? "", /not the incomplete high-stakes run/);
  assert.match(hsResumeRefusal({ ...base, head: "x" })?.text ?? "", /head moved/);
  assert.match(hsResumeRefusal({ ...base, tree: "x" })?.text ?? "", /work tree changed/);
  assert.equal(hsResumeRefusal({ ...base, usage: { tokens: 61, contextWindow: 100 } })?.reason, "high_stakes_resume_context");
  assert.equal(hsResumeRefusal({ ...base, usage: { tokens: 60, contextWindow: 100 } }), null, "the threshold is the final-compaction share");
  assert.equal(hsResumeRefusal({ ...base, usage: { tokens: null, contextWindow: 100 } }), null, "unknown tokens read as below");
});

test("the incomplete run and the fresh run after it count as one review: only a verdict is a run, and a FAIL pair leaves a second review available", () => {
  const s = st({ incomplete: inc, runIds: [{ id: "r1", cwd: "/c" }, { id: "r2", cwd: "/c", from: "r1" }], runs: [{ verdict: "fail", head: "h", cwd: "/c", revised: true, handed: true, cleared: true }] });
  assert.equal(s.runs.length, 1);
  assert.equal(used(s), false, "one counted review: the second is still available");
});

const FAIL_SPEC: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "broken", file: "src/a/x.ts", line: 1 }] };

test("after a reload the resumed run's verdict is recorded: one high-stakes run, the incomplete record cleared, a FAIL sets the gate", async (t) => {
  const { w, a } = await standing(t);
  const first = await incompleteRun(a, w);
  await a.down();
  const b = await w.adapter("reload");
  await tick(50);
  const r = await resume(b, first);
  assert.equal(r.blocked, null, String(r.blocked));
  a.record(first.id, FAIL_SPEC); // the folder of the first launch (only the first rig knows its binding)
  await b.endRunAs(r.id, "reviewer", "report");
  await persisted(w, (hs) => hs?.runs?.length === 1 && hs.incomplete === undefined);
  assert.equal(hsOf(w)?.runs?.[0]?.verdict, "fail");
  assert.match(await pr(b), /\[pr_refused:high_stakes_failed\]/, "the FAIL set the gate");
});

test("the incomplete record carries the model the run ran on, and a resume after a reload is held to the high-stakes model by it", async (t) => {
  const { w, a } = await standing(t);
  await incompleteRun(a, w);
  await persisted(w, (hs) => hs?.incomplete?.model === MODEL);
  const call = { action: "resume", id: "run-x" };
  const ctx = { allowWorkflow: false, runs: new Map(), allowed: [] as string[], resolution: {} as never, maxThinking: undefined };
  const check = (ranOn: string | null) => subagentActionCheck(call, { ...ctx, hs: { run: () => true, model: MODEL, ranOn: () => ranOn } });
  assert.deepEqual(check(MODEL), {});
  assert.deepEqual(check(null), {});
  assert.match(check("fake/other").block ?? "", /ran on fake\/other, the high-stakes model now is fake\/hs/);
});
