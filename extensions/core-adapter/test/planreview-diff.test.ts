// Facts of a `[plan-review]` launch: the owner line "present (checked by the harness)";
// on a re-review the diff of the plan against the last reviewed version (planreview.ts planDiffLines, PlanReviews.noteLaunch /
// keepReviewed / reviewedText), kept in memory only and cleared when the plan changed while the reviewer ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLAN_DIFF_LINES, PlanReviews, planDiffLines } from "../planreview.ts";
import { ownerFactsLines } from "../ownertext.ts";
import { PLAN, tick, world } from "./_r46world.ts";

const tmpDiffDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("pf-plandiff-"));

test("planDiffLines: no difference, a diff with the plan path in the header, and no temp dir left", (t) => {
  // os.tmpdir() follows TMPDIR (POSIX) / TEMP (Windows) at call time: a private temp root keeps other processes out of the comparison.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plandiff-root-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = own;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    fs.rmSync(own, { recursive: true, force: true });
  });
  assert.equal(fs.realpathSync(os.tmpdir()), fs.realpathSync(own), "the code under test sees the private temp root");
  const before = tmpDiffDirs();
  assert.deepEqual(planDiffLines(".workflow/scratch/plan-x.md", "a\nb\n", "a\nb\n"), ["no difference to the last reviewed version"]);
  const d = planDiffLines(".workflow/scratch/plan-x.md", "a\nb\nc\n", "a\nB\nc\n");
  assert.equal(d[0], "--- .workflow/scratch/plan-x.md (last reviewed)");
  assert.equal(d[1], "+++ .workflow/scratch/plan-x.md (now)");
  assert.ok(d.includes("-b") && d.includes("+B"), d.join("\n"));
  assert.ok(!d.join("\n").includes("pf-plandiff-"), "no temp path");
  assert.deepEqual(tmpDiffDirs(), before);
});

test("planDiffLines: at most 200 lines, then a count", () => {
  const many = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const d = planDiffLines("p.md", "", `${many}\n`);
  assert.equal(d.length, PLAN_DIFF_LINES + 1);
  assert.match(d[d.length - 1], /^\(\+\d+ more diff lines/);
});

test("PlanReviews: the text noted at launch is kept at the verdict only when the version hash matches", () => {
  const r = new PlanReviews();
  assert.equal(r.reviewedText("/p/plan-a.md"), null);
  r.noteLaunch("/p/plan-a.md", "h1", "text one");
  assert.equal(r.reviewedText("/p/plan-a.md"), null, "not reviewed before a verdict");
  r.keepReviewed("/p/plan-a.md", "h1");
  assert.equal(r.reviewedText("/p/plan-a.md"), "text one");
  r.noteLaunch("/p/plan-a.md", "h2", "text two");
  r.keepReviewed("/p/plan-a.md", "h3"); // edited while the reviewer ran
  assert.equal(r.reviewedText("/p/plan-a.md"), null, "cleared");
});

test("ownerFactsLines: the harness check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), `# P\n\n## For the owner\n\n${"word ".repeat(30).trim()}\nshort\n\n## Goal\nx\n`);
    const [line] = ownerFactsLines(["a.md"], dir);
    assert.match(line, /present \(checked by the harness\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A `[plan-review]` launch through the real hook; the task text the reviewer gets, and the run id. */
async function launch(a: Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>, id: string): Promise<string> {
  const input = { agent: "reviewer", task: "[plan-review] review .workflow/scratch/plan-widget.md" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  assert.equal(await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input }), undefined);
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return input.task;
}

test("facts: no diff on a first review; a diff and the instruction on a re-review; none after the plan changed during the run", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const first = await launch(a, "f1");
  assert.match(first, /present \(checked by the harness\)/);
  assert.ok(!/Re-review of/.test(first), first);
  a.endRun("f1", "Overall verdict: FAIL\n");
  await tick();
  fs.writeFileSync(w.planFile, PLAN.replace("Ship it.", "Ship it twice."));
  const second = await launch(a, "f2");
  assert.match(second, /Re-review of \.workflow\/scratch\/plan-widget\.md: verify that the findings of the earlier review are fixed, and review the changed text in full/);
  assert.match(second, /^-Ship it\.$/m);
  assert.match(second, /^\+Ship it twice\.$/m);
  assert.ok(!second.includes("pf-plandiff-"));
  a.endRun("f2", "Overall verdict: PASS\n");
  await tick();
  // the plan is edited while the third reviewer runs: its verdict is for another version, so the reviewed text is cleared
  const third = await launch(a, "f3");
  assert.match(third, /no difference to the last reviewed version/);
  fs.writeFileSync(w.planFile, PLAN.replace("Ship it.", "Ship it thrice."));
  a.endRun("f3", "Overall verdict: FAIL\n");
  await tick();
  const fourth = await launch(a, "f4");
  assert.match(fourth, /no diff \(the last reviewed version is not in memory\)/);
});
