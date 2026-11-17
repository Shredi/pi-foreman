// The high-stakes review fires from risk, wired into the adapter (the conditions of the plan's Tests section): every tag, parser alone, no size trigger,
// heavy, lowering the tier, one review per session wherever the work lands, a FAIL whose worktree is gone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { build, commitIn, end, git, hsPass, hsRun, launch, pr, setup, settle, stakes, worktree } from "./_hsrig.ts";
import type { SetupOpts } from "./_hsrig.ts";

const SIZING_OFF: SetupOpts = { cfg: { ladder: { sizing: { enabled: false } } } };
const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
/** The launch fields of a risk tag: with sizing on a size field is needed too, with sizing off the tag alone is read. */
const tagged = (risk: string[], sizing: boolean) => (sizing ? sized(risk) : { risk });
const refused = (text: string) => assert.match(text, /\[pr_refused:high_stakes_required\]/);

const TAGS = ["security", "permission", "guard", "concurrency", "design"];

for (const sizing of [true, false]) {
  test(`risk tags ${TAGS.join(", ")} on a one-line change each fire the review with sizing ${sizing ? "on" : "off"}${sizing ? "; the pass stays valid after a fast-forward into the base branch" : ""}`, async (t) => {
    const { w, a } = await setup(t, sizing ? {} : SIZING_OFF);
    for (const m of ["a", "b", "c", "d", "e", "f"]) {
      fs.mkdirSync(path.join(w.project, "src", m), { recursive: true });
      fs.writeFileSync(path.join(w.project, "src", m, "big.ts"), "x\n".repeat(150)); // 900 lines in 6 modules, one commit
    }
    commitIn(w.project, "src/a/x.ts");
    // the parser tag alone fires nothing (the parser tag is no trigger)
    const parser = await launch(a, "builder", "build the widget", tagged(["parser"], sizing));
    assert.equal(parser.blocked, null, String(parser.blocked));
    assert.deepEqual(await stakes(w), [], "the parser tag alone fires nothing");
    assert.doesNotMatch(await pr(a), /high_stakes/, "the PR gate asks for no high-stakes review");
    await end(a, parser, "builder", "done");
    if (sizing) {
      // an untagged large change (900 lines, 6 modules) fires nothing: the size is no trigger
      await build(a, { size: { files: ["src/a/big.ts", "src/b/big.ts", "src/c/big.ts", "src/d/big.ts", "src/e/big.ts", "src/f/big.ts"] } });
      assert.deepEqual(await stakes(w), [], "an untagged large change fires nothing");
      assert.equal(await pr(a), "");
      assert.equal(await settle(a), "");
      // a heavy builder launch needs an approved plan; the tier is raised after the build (the gates read it)
      await a.command("ceremony", "heavy");
      const heavy = await pr(a);
      refused(heavy);
      assert.match(heavy, /the task is heavy/);
      await a.command("ceremony", "standard");
      assert.doesNotMatch(await pr(a), /high_stakes/, "the owner's standard drops the heavy reason");
    } else {
      const large = await launch(a, "builder", "build the widget", {});
      assert.equal(large.blocked, null, String(large.blocked));
      assert.deepEqual(await stakes(w), [], "an untagged large change fires nothing with sizing off");
      await end(a, large, "builder", "done");
    }
    await build(a, tagged(TAGS, sizing));
    const fired = await stakes(w);
    assert.equal(fired.length, sizing ? 2 : 1, "the tags fire once, after the heavy tier of the sizing-on session");
    assert.deepEqual(String(fired.at(-1)).split(",").sort(), [...TAGS].sort(), "every tag is a reason");
    const text = await pr(a);
    refused(text);
    for (const tag of TAGS) assert.match(text, new RegExp(`\\b${tag}\\b`));
    assert.match(text, /risk tag /);
    if (sizing) {
      // tier heavy joins the tags, then the owner's /ceremony standard drops only the heavy reason
      await a.command("ceremony", "heavy");
      assert.match(await pr(a), /risk tag .*; the task is heavy/);
      await a.command("ceremony", "standard");
      const lowered = await pr(a);
      refused(lowered);
      assert.match(lowered, /risk tag /);
      assert.doesNotMatch(lowered, /the task is heavy/, "only the heavy reason is dropped");
      assert.match(await settle(a), /a high-stakes review must run/);
      await hsPass(a);
      git(w.project, "checkout", "-q", "main");
      git(w.project, "merge", "-q", "--ff-only", "feature");
      assert.doesNotMatch(await pr(a), /high_stakes/, "main holds the reviewed head");
      assert.doesNotMatch(await settle(a), /high-stakes review must run/);
    }
  });
}

test("heavy with no builder and no change asks for none; a builder launched while heavy makes the review due at the launch; builders in three worktrees ask for exactly one review", async (t) => {
  const { w, a } = await setup(t, { tier: "heavy" });
  assert.doesNotMatch(await settle(a), /high-stakes/);
  assert.doesNotMatch(await pr(a), /high_stakes/);
  assert.deepEqual(await stakes(w), []);

  w.state.answer = "allow once"; // a launch in a sibling asks the gate
  const wts = ["w1", "w2", "w3"].map((n) => worktree(w, n));
  commitIn(wts[0], "src/a/w1.ts");
  const b = await launch(a, "builder", "build the widget", { cwd: wts[0] });
  assert.equal(b.blocked, null, String(b.blocked));
  assert.deepEqual(await stakes(w), ["heavy"], "fired at the launch, before any gate");
  await end(a, b, "builder", "done", wts[0]);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch", { cwd: wts[0] }), "reviewer", "Overall verdict: PASS", wts[0]);
  for (const dir of wts.slice(1)) {
    commitIn(dir, `src/a/${path.basename(dir)}.ts`);
    await build(a, {}, dir);
  }
  assert.deepEqual(await stakes(w), ["heavy"]);
  const text = await pr(a, { head: "w1" });
  refused(text);
  assert.match(text, /the task is heavy/);
  await hsPass(a, wts[1]);
  for (const head of ["w1", "w2", "w3"]) assert.doesNotMatch(await pr(a, { head }), /high_stakes/, "one review covers every worktree");
  assert.doesNotMatch(await settle(a), /high-stakes/);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wts[2] });
  assert.match(again.blocked ?? "", /\[high_stakes_done\]/, "exactly one");
});

// the heavy-only lowering (the PR gate and the finish gate stop asking after the owner's /ceremony below heavy) is asserted in highstakes-owner-tier.test.ts,
// a tag reason staying after the lowering in the sizing-on tag test above

// ---------------------------------------------------------------- one review per session, wherever the work lands

for (const remote of [true, false]) {
  test(`one review per session ${remote ? "with a remote" : "without a remote"}: the pass in worktree W stands after the fast-forward into main, a commit on top, a PR from an unrelated branch or a second repository, W removed, and a later tagged builder`, async (t) => {
    const { w, a, root, seed } = await setup(t, { remote, onMain: true });
    w.state.answer = "allow once";
    const wt = worktree(w, "wbr");
    commitIn(wt, "src/a/x.ts");
    await build(a, sized(["design"]), wt);
    refused(await pr(a, { head: "wbr" }));
    await hsPass(a, wt);
    assert.doesNotMatch(await pr(a, { head: "wbr" }), /high_stakes/);

    git(w.project, "merge", "-q", "--ff-only", "wbr");
    const none = async (what: string) => {
      assert.doesNotMatch(await pr(a), /high_stakes/, `PR from main: ${what}`);
      assert.doesNotMatch(await settle(a), /high-stakes review must run|high-stakes FAIL/, `finish gate: ${what}`);
    };
    await none("main holds the reviewed head");
    commitIn(w.project, "src/a/more.ts");
    await none("a commit on top of the pass in main");
    git(w.project, "checkout", "-q", "-b", "unrelated", seed);
    commitIn(w.project, "src/z/z.ts");
    await none("a PR from an unrelated branch");
    const repo2 = path.join(root, "repo2");
    execFileSync("git", ["init", "-q", "-b", "main", repo2]);
    commitIn(repo2, "r.txt");
    assert.doesNotMatch(await pr(a, { cwd: repo2 }), /high_stakes/, "a PR from a second repository");
    git(w.project, "worktree", "remove", "--force", wt);
    await none("W removed after the merge");
    const later = await launch(a, "builder", "build more", sized(["security"]));
    assert.equal(later.blocked, null, String(later.blocked));
    await none("a later tagged builder after the pass");
    assert.ok(fs.existsSync(w.project));
  });
}

test("a FAIL whose worktree was removed keeps the PR gate and the finish gate closed and says so", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  const wt = worktree(w, "gone");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  await hsRun(a, "FAIL", wt);
  git(w.project, "worktree", "remove", "--force", wt);
  const text = await pr(a, { head: "gone" });
  assert.match(text, /\[pr_refused:high_stakes_failed\]/);
  assert.match(text, /that checkout is gone/);
  const fin = await settle(a);
  assert.match(fin, /revise after the high-stakes FAIL/);
  assert.match(fin, /that checkout is gone/);
});

// ---------------------------------------------------------------- only the owner lowers the heavy reason

const NOT_DUE = /high_stakes/;
const FINISH = /a high-stakes review must run/;
/** A complete ledger (every item but V marked) for the finish gate; `tier` adds a header line. */
const finishLedger = (tier?: string) => `# Ledger: x\n${tier ? `Tier: ${tier}\n` : ""}\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n`;

async function defaultHeavy(t: Parameters<typeof setup>[0]) {
  const r = await setup(t, { tier: "heavy", noOwner: true });
  commitIn(r.w.project, "src/a/x.ts");
  await build(r.a);
  assert.deepEqual(await stakes(r.w), ["heavy"]);
  refused(await pr(r.a));
  return r;
}

test("default-heavy: neither the foreman's own foreman_triage standard nor a ledger Tier: standard line drops the heavy reason; the owner's /ceremony standard does", async (t) => {
  const { a } = await defaultHeavy(t);
  await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  await a.writeLedger(finishLedger());
  refused(await pr(a));
  assert.match(await settle(a), FINISH);
  await a.writeLedger(finishLedger("standard"));
  refused(await pr(a));
  assert.match(await settle(a), FINISH);
  await a.command("ceremony", "standard");
  await a.writeLedger(finishLedger());
  assert.doesNotMatch(await pr(a), NOT_DUE);
  assert.doesNotMatch(await settle(a), FINISH);
});
