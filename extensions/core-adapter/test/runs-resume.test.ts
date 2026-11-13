// A resumed run continues the row of the run it resumes (runs.ts ChildRuns.onResumed): one row per piece of work.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildRuns, UsageTail } from "../runs.ts";
import { resumeTarget } from "../actions.ts";
import { LiveState, liveDir } from "../livestate.ts";

const MODEL = "anthropic/claude-sonnet-5-5";
const usage = (launchId: string, cost: number) => JSON.stringify({ role: "builder", launchId, input: 10, cacheRead: 0, cacheWrite: 0, output: 2, cost: { total: cost } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-resume-"));

function launched(c: ChildRuns): void {
  c.onLaunchCall("call1", { launchId: "L1", role: "builder", rung: "model", model: MODEL });
  c.onLaunched("call1", "run1", [], 1000);
}

test("resume with a new run id: one row, under the original launch id, model and rung, working again", () => {
  const d = tmp();
  const f = path.join(d, "u.jsonl");
  fs.writeFileSync(f, usage("L1", 0.5) + "\n");
  const c = new ChildRuns(new UsageTail(f));
  launched(c);
  c.onRunEnd("run1", 2000);
  c.onResumed("call2", "run2", "run1", ["builder"], 3000);
  const v = c.views();
  assert.equal(v.length, 1);
  assert.equal(v[0].launchId, "L1");
  assert.equal(v[0].model, MODEL);
  assert.equal(v[0].rung, "model");
  assert.equal(v[0].role, "builder");
  assert.equal(v[0].state, "working");
  assert.equal(v[0].endedAt, null);
  assert.equal(v[0].startedAt, 1000);
  assert.equal(v[0].cost, 0.5);
  assert.equal(c.info("run1"), null, "the old run id is gone");
  // usage lines written under the launch id after the resume count on the same row
  fs.appendFileSync(f, usage("L1", 0.25) + "\n");
  assert.equal(c.views()[0].cost, 0.75);
  assert.equal(c.info("run2")?.cost, 0.75);
  c.onRunEnd("run2", 5000);
  assert.equal(c.views()[0].state, "done");
  assert.deepEqual(c.info("run2"), { ms: 4000, cost: 0.75 });
});

test("resume reporting the same run id keeps launch id, model and rung (no null overwrite)", () => {
  const c = new ChildRuns();
  launched(c);
  c.onRunEnd("run1", 2000);
  c.onResumed("call2", "run1", "run1", ["builder"], 3000);
  const v = c.views();
  assert.equal(v.length, 1);
  assert.equal(v[0].launchId, "L1");
  assert.equal(v[0].model, MODEL);
  assert.equal(v[0].rung, "model");
  assert.equal(v[0].state, "working");
});

test("resume of an unknown run behaves as a plain launch: no crash, a row under the run id", () => {
  const c = new ChildRuns();
  c.onResumed("call2", "run9", "nope", ["builder"], 3000);
  c.onResumed("call3", "run8", null, ["reviewer"], 3000);
  const v = c.views();
  assert.deepEqual(v.map((r) => [r.launchId, r.role, r.model, r.rung]), [["run9", "builder", null, null], ["run8", "reviewer", null, null]]);
});

test("a resumed run that already ended before its result is done at once", () => {
  const c = new ChildRuns();
  launched(c);
  c.onRunEnd("run2", 2500);
  c.onResumed("call2", "run2", "run1", ["builder"], 3000);
  assert.equal(c.views()[0].state, "done");
});

test("an early end is consumed: a run resumed under the same run id is working until its next run end", () => {
  const c = new ChildRuns();
  c.onLaunchCall("call1", { launchId: "L1", role: "builder", rung: "model", model: MODEL });
  c.onRunEnd("run1", 1500);
  c.onLaunched("call1", "run1", [], 1000);
  assert.equal(c.views()[0].state, "done");
  c.onResumed("call2", "run1", "run1", ["builder"], 3000);
  assert.equal(c.views()[0].state, "working");
  assert.equal(c.views()[0].endedAt, null);
  c.onRunEnd("run1", 4000);
  assert.equal(c.views()[0].state, "done");
  assert.equal(c.views()[0].endedAt, 4000);
});

test("livestate file: the resumed row carries the model, one row for the work", () => {
  const d = tmp();
  const c = new ChildRuns();
  launched(c);
  c.onResumed("call2", "run2", "run1", ["builder"], 3000);
  const l = LiveState.start({ agentDir: d, sessionId: "sess1", cwd: "/w", mode: "rpc", env: {}, pid: 1 }, () => c.views());
  assert.ok(l);
  const j = JSON.parse(fs.readFileSync(path.join(liveDir(d), "sess1.json"), "utf8"));
  assert.equal(j.runs.length, 1);
  assert.equal(j.runs[0].launchId, "L1");
  assert.equal(j.runs[0].model, MODEL);
  assert.equal(j.runs[0].rung, "model");
  l.stop();
});

test("resumeTarget: id, else runId; null when absent or the two differ", () => {
  assert.equal(resumeTarget({ action: "resume", id: " r1 " }), "r1");
  assert.equal(resumeTarget({ action: "resume", runId: "r2" }), "r2");
  assert.equal(resumeTarget({ action: "resume", id: "a", runId: "b" }), null);
  assert.equal(resumeTarget({ action: "resume" }), null);
});
