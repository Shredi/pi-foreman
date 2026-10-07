import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptySteps, missingSteps, requiredSteps, stepsOfRunEnd } from "../bound.ts";
import { isPlannerChild, plannerLaunchBlock, plannerWriteBlock } from "../plannerscope.ts";
import { outputPathBlock, uncheckedHeavyBlock } from "../actions.ts";
import type { RunRegistry } from "../actions.ts";

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch", "src"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  return { root, ws, opts: { cwd: ws, home: root, platform: process.platform } };
}

test("planner scope: only a child with role planner", () => {
  assert.equal(isPlannerChild(true, "planner"), true);
  assert.equal(isPlannerChild(true, "builder"), false);
  assert.equal(isPlannerChild(false, "planner"), false);
});

test("planner write scope: plan and .workflow notes pass, project files and moves are refused", (t) => {
  const { opts } = workspace(t);
  const block = (tool: string, input: Record<string, unknown>) => plannerWriteBlock(tool, input, ".workflow/scratch", opts);
  assert.equal(block("write", { path: ".workflow/scratch/plan-x.md", content: "x" }), undefined);
  assert.equal(block("edit", { path: ".workflow/notes.md" }), undefined);
  assert.equal(block("read", { path: "src/a.ts" }), undefined);
  const w = block("write", { path: "src/a.ts", content: "x" }) ?? "";
  assert.match(w, /write on 'src\/a\.ts' refused: The planner writes only the plan under \.workflow\/scratch/);
  assert.match(block("foreman_move", { src: ".workflow/a.md", dst: "src/b.md" }) ?? "", /foreman_move.*planner writes only/);
});

test("planner write scope: outside the workspace is refused (absolute, `..`, `~`)", (t) => {
  const { root, opts } = workspace(t);
  const block = (tool: string, input: Record<string, unknown>) => plannerWriteBlock(tool, input, ".workflow/scratch", opts);
  for (const p of [path.join(root, "evil.txt"), path.join(os.tmpdir(), "evil.txt"), "../sibling/README.md", "~/.zshrc-probe", ".workflow/../../x.md"]) {
    assert.match(block("write", { path: p, content: "x" }) ?? "", /refused: outside the workspace\. The planner writes only/, p);
  }
  assert.match(block("foreman_copy", { src: ".workflow/a.md", dst: "../b.md" }) ?? "", /foreman_copy on '\.\.\/b\.md' refused: outside the workspace/);
  assert.equal(block("write", { path: ".workflow/scratch/plan-x.md", content: "x" }), undefined);
});

test("launch: output/outputMode refused at the top level and in every step; unchecked workflow refused at heavy", () => {
  const re = /^pi-foreman: subagent launch refused \[launch_refused:output_path\]: /;
  assert.equal(outputPathBlock({ agent: "planner", task: "t" }), undefined);
  assert.equal(outputPathBlock({ agent: "explorer", task: "t", output: false }), undefined);
  assert.match(outputPathBlock({ agent: "planner", task: "t", output: "/abs/src/x.ts" }) ?? "", re);
  assert.match(outputPathBlock({ agent: "explorer", task: "t", output: true }) ?? "", re);
  assert.match(outputPathBlock({ agent: "explorer", task: "t", outputMode: "inline" }) ?? "", re);
  assert.match(outputPathBlock({ chain: [{ agent: "explorer", task: "a" }, { agent: "reviewer", task: "b", output: "../x.md" }] }) ?? "", re);
  assert.match(outputPathBlock({ chain: [{ parallel: [{ agent: "explorer", task: "a", outputMode: "file-only" }] }] }) ?? "", re);
  assert.match(outputPathBlock({ tasks: [{ agent: "explorer", task: "a", output: "o.md" }] }) ?? "", re);
  assert.match(uncheckedHeavyBlock("workflow", "heavy") ?? "", /^pi-foreman: subagent launch refused \[launch_refused:unchecked_heavy\]: 'workflow'/);
  assert.equal(uncheckedHeavyBlock("schedule.create", "standard"), undefined);
  assert.equal(uncheckedHeavyBlock(undefined, "heavy"), undefined);
});

test("planner launch: single passes, tasks/chain/parallel/resume refused", () => {
  const runs: RunRegistry = new Map([["r1", { role: "planner", model: null }], ["r2", { role: "builder", model: null }]]);
  const block = (i: Record<string, unknown>) => plannerLaunchBlock(i, runs);
  assert.equal(block({ agent: "planner", task: "t" }), undefined);
  assert.equal(block({ agent: "builder", task: "t" }), undefined);
  assert.equal(block({ action: "resume", id: "r2", message: "m" }), undefined);
  const re = /planner launch refused \[launch_refused:planner_single\]: .*launch one planner with subagent\(\{agent:"planner", task\}\)/;
  assert.match(block({ tasks: [{ agent: "planner", task: "a" }, { agent: "explorer", task: "b" }] }) ?? "", re);
  assert.match(block({ chain: [{ agent: "explorer", task: "a" }, { agent: "planner", task: "b" }] }) ?? "", re);
  assert.match(block({ chain: [{ parallel: [{ agent: "planner", task: "a" }] }] }) ?? "", re);
  assert.match(block({ agent: "planner", tasks: [{ agent: "explorer", task: "a" }] }) ?? "", re);
  assert.match(block({ action: "resume", id: "r1", message: "m" }) ?? "", re);
});

test("planner step: a completed planner run counts and the required list names a missing one", () => {
  assert.deepEqual(stepsOfRunEnd({ runId: "r", agent: "planner", success: true }), ["planner"]);
  assert.deepEqual(stepsOfRunEnd({ runId: "r", agent: "planner", success: false, timedOut: true }), []);
  const req = { heavy: ["planner", "builder"] };
  assert.deepEqual(requiredSteps(req, "heavy"), ["planner", "builder"]);
  const counts = emptySteps();
  counts.builder++;
  assert.deepEqual(missingSteps(counts, requiredSteps(req, "heavy")), ["planner"]);
});
