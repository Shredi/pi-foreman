#!/usr/bin/env node
// `npm run test:ci`: every check CI runs that a local machine can run, in CI's order (unit, core-pin, ruff, conformance, node, installer, typecheck, replay, bench).
// The fresh-install job stays out (it needs the network). One line per step; exits 1 when a step fails.
// The unit and node steps go through scripts/foreman_test_run.mjs and run with inherited output, so the runner's run id and lock-wait lines show; FOREMAN_TEST_TIMEOUT applies to each of them.
// Replay is the slow step (scripts/replay_run.mjs runs the modules in parallel and prints its wall time). `--only <step>` runs one step (any name above).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pickTrialResult } from "./foreman_ci_bench.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = process.platform === "win32" ? "python" : "python3";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Runs a command in the repo root with its output captured; the caller shows it only on a failure. */
function exec(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Runs a command in the repo root with its output inherited (the test runner prints its run id there). */
function execInherited(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && cmd.endsWith(".cmd") });
  return { ok: r.status === 0, status: r.status, out: "" };
}

const tail = (out) => out.trimEnd().split("\n").slice(-60).join("\n");

function unit() {
  const r = execInherited(npm, ["test"]);
  return { status: r.ok ? "pass" : "fail", line: r.ok ? "npm test" : `npm test exit ${r.status}` };
}

function corePin() {
  const r = exec(py, ["scripts/pull_core.py", "--check"]);
  return { status: r.ok ? "pass" : "fail", line: r.ok ? "core pin matches" : `exit ${r.status}`, out: r.out };
}

function ruff() {
  if (!exec("ruff", ["--version"]).ok) return { status: "skip", line: "ruff is not installed, so the lint is skipped; install it with python -m pip install -r .github/lint-requirements.txt" };
  const r = exec("ruff", ["check", "."]);
  return { status: r.ok ? "pass" : "fail", line: r.ok ? "ruff check ." : `exit ${r.status}`, out: r.out };
}

function nodeTests() {
  const r = execInherited(npm, ["run", "test:node"]);
  return { status: r.ok ? "pass" : "fail", line: r.ok ? "npm run test:node" : `npm run test:node exit ${r.status}` };
}

function typecheck() {
  const r = exec(npm, ["run", "typecheck"]);
  return { status: r.ok ? "pass" : "fail", line: r.ok ? "tsc --noEmit" : `exit ${r.status}`, out: r.out };
}

function replay() {
  const cli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  if (!fs.existsSync(cli)) return { status: "fail", line: `Pi CLI missing at ${cli} (run npm install)`, out: "" };
  const r = exec(process.execPath, ["scripts/replay_run.mjs"], { FOREMAN_PI_CLI: cli, FOREMAN_REPLAY_REQUIRED: "1" });
  const counts = /replay modules: (\d+) passed, (\d+) failed/.exec(r.out);
  return { status: r.ok ? "pass" : "fail", line: counts ? `${counts[1]} modules passed, ${counts[2]} failed` : `exit ${r.status}`, out: r.out };
}

function conformance() {
  if (!exec(py, ["-c", "import pytest"]).ok) return { status: "skip", line: "pytest is not installed, so the conformance run is skipped; install it with python -m pip install pytest" };
  const r = exec(py, ["scripts/pull_core.py", "--conformance"]);
  const summary = r.out.split("\n").find((l) => l.startsWith("core conformance")) ?? `exit ${r.status}`;
  return { status: r.ok ? "pass" : "fail", line: summary, out: r.out };
}

function installer() {
  const files = fs.readdirSync(path.join(root, "tests", "installer")).filter((f) => f.endsWith(".test.mjs")).map((f) => `tests/installer/${f}`);
  const r = exec(process.execPath, ["--import", "./tests/installer/_hermetic-env.mjs", "--test", ...files]);
  const pass = /# pass (\d+)/.exec(r.out);
  const fail = /# fail (\d+)/.exec(r.out);
  return { status: r.ok ? "pass" : "fail", line: `${pass ? pass[1] : "?"} passed, ${fail ? fail[1] : "?"} failed`, out: r.out };
}

function bench() {
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["harbor"], { stdio: "ignore" });
  if (lookup.status !== 0) return { status: "skip", line: "harbor is not on PATH (the bench probe needs Harbor)" };
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ci-bench-"));
  try {
    const r = exec(py, ["scripts/foreman_bench.py", "run", "--preset", "bench/presets/smoke.json", "--rows", "foreman-fake", "--task", "detach-probe", "--jobs-dir", jobs], { HARBOR_TELEMETRY: "off" });
    if (!r.ok) return { status: "fail", line: `bench run exit ${r.status}`, out: r.out };
    const result = pickTrialResult(jobs);
    if (result === null) return { status: "fail", line: "no result.json for detach-probe", out: r.out };
    const reward = JSON.parse(fs.readFileSync(result, "utf8")).verifier_result?.rewards?.reward;
    if (reward !== 1) return { status: "fail", line: `detach-probe reward ${reward}, need 1`, out: r.out };
    return { status: "pass", line: "detach-probe reward 1", out: r.out };
  } finally {
    fs.rmSync(jobs, { recursive: true, force: true });
  }
}

/** The steps in CI order; `inherited` ones print their own output (the test runner), the others are captured and shown on a failure. */
export const STEPS = [
  { name: "unit", run: unit, inherited: true },
  { name: "core-pin", run: corePin, inherited: false },
  { name: "ruff", run: ruff, inherited: false },
  { name: "conformance", run: conformance, inherited: false },
  { name: "node", run: nodeTests, inherited: true },
  { name: "installer", run: installer, inherited: false },
  { name: "typecheck", run: typecheck, inherited: false },
  { name: "replay", run: replay, inherited: false },
  { name: "bench", run: bench, inherited: false },
];

function main() {
  const argOnly = process.argv.indexOf("--only");
  const only = argOnly === -1 ? null : process.argv[argOnly + 1];
  if (only !== null && !STEPS.some((st) => st.name === only)) {
    console.error(`unknown step ${only}; one of ${STEPS.map((st) => st.name).join(", ")}`);
    process.exit(2);
  }
  let failed = 0;
  for (const step of STEPS) {
    if (only !== null && only !== step.name) continue;
    const started = Date.now();
    const r = step.run();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${r.status.toUpperCase().padEnd(4)} ${step.name}: ${r.line} (${secs}s)`);
    if (r.status === "fail") {
      failed += 1;
      if (r.out) console.log(tail(r.out));
    }
  }
  if (failed > 0) {
    console.log(`test:ci failed: ${failed} step(s)`);
    process.exit(1);
  }
  console.log("test:ci passed");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
