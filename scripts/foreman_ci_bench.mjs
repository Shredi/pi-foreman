// The bench step's pick in scripts/foreman_ci.mjs: the trial result.json of the detach-probe job, not the job-level file.
// Harbor writes a job-level result.json (no verifier_result) beside one directory per trial, and the trial's result.json (with verifier_result) sits one directory below the job dir.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const BENCH_JOB_PREFIX = "foreman-fake__detach-probe__r1__";

/** The trial result.json of the latest detach-probe job dir in jobsDir, or null when that job has none. */
export function pickTrialResult(jobsDir) {
  const jobs = fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(BENCH_JOB_PREFIX)).map((e) => e.name).sort();
  if (jobs.length === 0) return null;
  const jobDir = path.join(jobsDir, jobs[jobs.length - 1]);
  const trials = fs.readdirSync(jobDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(jobDir, e.name, "result.json")).filter((f) => fs.existsSync(f)).sort();
  return trials.length === 0 ? null : trials[trials.length - 1];
}

// `node scripts/foreman_ci_bench.mjs <jobsDir>` prints the pick (the CI workflow's assertion step reads it); exits 1 with a message when there is none.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const jobsDir = process.argv[2];
  const found = jobsDir && fs.existsSync(jobsDir) ? pickTrialResult(jobsDir) : null;
  if (!found) {
    console.error(`no ${BENCH_JOB_PREFIX}* trial result.json under ${jobsDir}`);
    process.exit(1);
  }
  console.log(found);
}
