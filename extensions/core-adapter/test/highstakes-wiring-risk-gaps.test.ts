// The high-stakes review fires from risk, wired into the adapter (the conditions of the plan's Tests section): every tag, parser alone, no size trigger,
// heavy, lowering the tier, one review per session wherever the work lands, a FAIL whose worktree is gone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { build, commitIn, git, hsPass, hsRun, launch, pr, setup, settle, stakes, worktree } from "./_hsrig.ts";
import type { SetupOpts } from "./_hsrig.ts";

const SIZING_OFF: SetupOpts = { cfg: { ladder: { sizing: { enabled: false } } } };
const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
/** The launch fields of a risk tag: with sizing on a size field is needed too, with sizing off the tag alone is read. */
const tagged = (risk: string[], sizing: boolean) => (sizing ? sized(risk) : { risk });
const refused = (text: string) => assert.match(text, /\[pr_refused:high_stakes_required\]/);

for (const sizing of [true, false]) {
  for (const tag of ["permission", "guard", "concurrency"]) {
    test(`risk tag ${tag} on a one-line change fires the review with sizing ${sizing ? "on" : "off"}`, async (t) => {
      const { w, a } = await setup(t, sizing ? {} : SIZING_OFF);
      commitIn(w.project, "src/a/x.ts");
      await build(a, tagged([tag], sizing));
      assert.deepEqual(await stakes(w), [tag]);
      const text = await pr(a);
      refused(text);
      assert.match(text, new RegExp(`risk tag ${tag}`));
    });
  }

  test(`the parser tag alone fires nothing, and neither does a large untagged change, with sizing ${sizing ? "on" : "off"}`, async (t) => {
    const { w, a } = await setup(t, sizing ? {} : SIZING_OFF);
    for (const m of ["a", "b", "c", "d", "e", "f"]) commitIn(w.project, `src/${m}/big.ts`, "x\n".repeat(150)); // 900 lines in 6 modules
    commitIn(w.project, "src/a/x.ts");
    await build(a, tagged(["parser"], sizing));
    assert.deepEqual(await stakes(w), [], "parser fires nothing");
    assert.equal(await pr(a), "");
    await build(a, sizing ? { size: { files: ["src/a/big.ts", "src/b/big.ts", "src/c/big.ts", "src/d/big.ts", "src/e/big.ts", "src/f/big.ts"] } } : {});
    assert.deepEqual(await stakes(w), [], "a large untagged change fires nothing");
    assert.equal(await pr(a), "");
    assert.equal(await settle(a), "");
  });
}

test("a builder launched while the tier is already heavy makes the review due at the launch", async (t) => {
  const { w, a } = await setup(t, { tier: "heavy" });
  commitIn(w.project, "src/a/x.ts");
  const b = await launch(a, "builder", "build the widget");
  assert.equal(b.blocked, null, String(b.blocked));
  assert.deepEqual(await stakes(w), ["heavy"], "fired at the launch, before any gate");
  await build(a);
  const text = await pr(a);
  refused(text);
  assert.match(text, /the task is heavy/);
});

test("heavy with builders in three worktrees asks for exactly one review; heavy with no builder and no change asks for none", async (t) => {
  const idle = await setup(t, { tier: "heavy" });
  assert.doesNotMatch(await settle(idle.a), /high-stakes/);
  assert.doesNotMatch(await pr(idle.a), /high_stakes/);
  assert.deepEqual(await stakes(idle.w), []);

  const { w, a } = await setup(t, { tier: "heavy" });
  w.state.answer = "allow once"; // a launch in a sibling asks the gate
  const wts = ["w1", "w2", "w3"].map((n) => worktree(w, n));
  for (const dir of wts) {
    commitIn(dir, "src/a/x.ts");
    await build(a, {}, dir);
  }
  assert.deepEqual(await stakes(w), ["heavy"]);
  refused(await pr(a, { head: "w1" }));
  await hsPass(a, wts[1]);
  for (const head of ["w1", "w2", "w3"]) assert.doesNotMatch(await pr(a, { head }), /high_stakes/, "one review covers every worktree");
  assert.doesNotMatch(await settle(a), /high-stakes/);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wts[2] });
  assert.match(again.blocked ?? "", /\[high_stakes_done\]/, "exactly one");
});

test("/ceremony standard after heavy fired the review drops it at the PR gate and the finish gate; a tag reason stays after the lowering", async (t) => {
  const heavy = await setup(t, { tier: "heavy" });
  commitIn(heavy.w.project, "src/a/x.ts");
  await build(heavy.a);
  refused(await pr(heavy.a));
  assert.match(await settle(heavy.a), /a high-stakes review must run/);
  await heavy.a.command("ceremony", "standard");
  assert.doesNotMatch(await pr(heavy.a), /high_stakes/, "the PR gate no longer asks");
  assert.doesNotMatch(await settle(heavy.a), /high-stakes review must run/, "the finish gate no longer asks");

  const tag = await setup(t, { tier: "heavy" });
  commitIn(tag.w.project, "src/a/x.ts");
  await build(tag.a, sized(["design"]));
  assert.deepEqual(await stakes(tag.w), ["design,heavy"]);
  await tag.a.command("ceremony", "standard");
  const text = await pr(tag.a);
  refused(text);
  assert.match(text, /risk tag design/);
  assert.doesNotMatch(text, /the task is heavy/, "only the heavy reason is dropped");
  assert.match(await settle(tag.a), /a high-stakes review must run/);
});

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

test("default-heavy: the foreman's own foreman_triage standard does not drop the heavy reason", async (t) => {
  const { a } = await defaultHeavy(t);
  await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  await a.writeLedger(finishLedger());
  refused(await pr(a));
  assert.match(await settle(a), FINISH);
});

test("default-heavy: a ledger Tier: standard line does not drop the heavy reason", async (t) => {
  const { a } = await defaultHeavy(t);
  await a.writeLedger(finishLedger("standard"));
  refused(await pr(a));
  assert.match(await settle(a), FINISH);
});

test("default-heavy: the owner's /ceremony standard drops the heavy reason", async (t) => {
  const { a } = await defaultHeavy(t);
  await a.command("ceremony", "standard");
  await a.writeLedger(finishLedger());
  assert.doesNotMatch(await pr(a), NOT_DUE);
  assert.doesNotMatch(await settle(a), FINISH);
});
