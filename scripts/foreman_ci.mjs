#!/usr/bin/env node
// `npm run test:ci`: the checks CI runs that `npm test` does not, in CI's order. One line per step; exits 1 when a step fails.
// Replay is the slow step (scripts/replay_run.mjs runs the modules in parallel and prints its wall time). `--only <step>` runs one step (replay, conformance, installer or bench).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = process.platform === "win32" ? "python" : "python3";
const STEPS = ["replay", "conformance", "installer", "bench"];
const argOnly = process.argv.indexOf("--only");
const only = argOnly === -1 ? null : process.argv[argOnly + 1];
if (only !== null && !STEPS.includes(only)) {
  console.error(`unknown step ${only}; one of ${STEPS.join(", ")}`);
  process.exit(2);
}

/** Runs a command in the repo root with its output captured; the caller shows it only on a failure. */
function exec(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const tail = (out) => out.trimEnd().split("\n").slice(-60).join("\n");

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
  const r = exec(process.execPath, ["--test", ...files]);
  const pass = /# pass (\d+)/.exec(r.out);
  const fail = /# fail (\d+)/.exec(r.out);
  return { status: r.ok ? "pass" : "fail", line: `${pass ? pass[1] : "?"} passed, ${fail ? fail[1] : "?"} failed`, out: r.out };
}

function findFiles(dir, name, found = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, name, found);
    else if (e.name === name) found.push(p);
  }
  return found;
}

function bench() {
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["harbor"], { stdio: "ignore" });
  if (lookup.status !== 0) return { status: "skip", line: "harbor is not on PATH (the bench probe needs Harbor)" };
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ci-bench-"));
  try {
    const r = exec(py, ["scripts/foreman_bench.py", "run", "--preset", "bench/presets/smoke.json", "--rows", "foreman-fake", "--task", "detach-probe", "--jobs-dir", jobs], { HARBOR_TELEMETRY: "off" });
    if (!r.ok) return { status: "fail", line: `bench run exit ${r.status}`, out: r.out };
    const results = findFiles(jobs, "result.json").filter((f) => f.includes("foreman-fake__detach-probe__r1__")).sort();
    if (results.length === 0) return { status: "fail", line: "no result.json for detach-probe", out: r.out };
    const reward = JSON.parse(fs.readFileSync(results[results.length - 1], "utf8")).verifier_result?.rewards?.reward;
    if (reward !== 1) return { status: "fail", line: `detach-probe reward ${reward}, need 1`, out: r.out };
    return { status: "pass", line: "detach-probe reward 1", out: r.out };
  } finally {
    fs.rmSync(jobs, { recursive: true, force: true });
  }
}

let failed = 0;
const checks = { replay, conformance, installer, bench };
for (const name of STEPS) {
  if (only !== null && only !== name) continue;
  const started = Date.now();
  const r = checks[name]();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${r.status.toUpperCase().padEnd(4)} ${name}: ${r.line} (${secs}s)`);
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
