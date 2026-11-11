// `npm run test:ci` bench step: the reward comes from the trial's result.json (one directory below the job dir), never the job-level file that sorts last.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pickTrialResult } from "../../scripts/foreman_ci_bench.mjs";

// The real Harbor shape: <jobs>/<job dir>/result.json (job level, no verifier_result) and <job dir>/<trial>/result.json (trial level).
function writeJob(jobsDir, jobName, { trial = null } = {}) {
  const jobDir = path.join(jobsDir, jobName);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ id: "job", started_at: "t", updated_at: "t", finished_at: "t", n_total_trials: 1, stats: {} }));
  if (trial !== null) {
    const trialDir = path.join(jobDir, trial.name);
    fs.mkdirSync(trialDir, { recursive: true });
    fs.writeFileSync(path.join(trialDir, "result.json"), JSON.stringify({ id: "trial", trial_name: trial.name, verifier_result: { rewards: { reward: trial.reward } } }));
  }
  return jobDir;
}

function withJobs(fn) {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ci-bench-test-"));
  try {
    fn(jobsDir);
  } finally {
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
}

const JOB = "foreman-fake__detach-probe__r1__20261111-173316";

test("the trial result is picked and its reward read, though the job-level file sorts last", () => {
  withJobs((jobsDir) => {
    writeJob(jobsDir, JOB, { trial: { name: "detach-probe__XiVDZdL", reward: 1 } });
    const picked = pickTrialResult(jobsDir);
    assert.equal(picked, path.join(jobsDir, JOB, "detach-probe__XiVDZdL", "result.json"));
    assert.ok(path.join(jobsDir, JOB, "result.json") > picked, "the job-level file must sort after the trial file for this case to mean anything");
    assert.equal(JSON.parse(fs.readFileSync(picked, "utf8")).verifier_result.rewards.reward, 1);
  });
});

test("a job dir with only the job-level file gives no result", () => {
  withJobs((jobsDir) => {
    writeJob(jobsDir, JOB);
    assert.equal(pickTrialResult(jobsDir), null);
  });
});

test("no job dir gives no result", () => {
  withJobs((jobsDir) => {
    writeJob(jobsDir, "foreman-fake__other-task__r1__20261111-173316", { trial: { name: "other__abc", reward: 1 } });
    assert.equal(pickTrialResult(jobsDir), null);
  });
});

test("with two job dirs the later one is picked", () => {
  withJobs((jobsDir) => {
    writeJob(jobsDir, "foreman-fake__detach-probe__r1__20261110-090000", { trial: { name: "detach-probe__OLD", reward: 0 } });
    writeJob(jobsDir, JOB, { trial: { name: "detach-probe__NEW", reward: 1 } });
    const picked = pickTrialResult(jobsDir);
    assert.equal(picked, path.join(jobsDir, JOB, "detach-probe__NEW", "result.json"));
    assert.equal(JSON.parse(fs.readFileSync(picked, "utf8")).verifier_result.rewards.reward, 1);
  });
});
