// Runs a test suite behind a machine-wide lock so parallel sessions queue instead of overloading the host.
// Usage: node scripts/foreman_test_run.mjs <node args and globs...>      -> node <leading options> --test --test-concurrency=N <globs>
//        node scripts/foreman_test_run.mjs --exec -- <command> [args...]  -> the command, lock only (no concurrency flag)
// Leading node options (`--import ./x.mjs`, other `-x` flags) stay before `--test`; the first plain argument starts the globs.
// A leading `--write-spawn-baseline` (npm run test:node:baseline) writes scripts/foreman_test_spawn_baseline.json, the child-process count per test file, when the run exits 0;
// a run over the budget names the files that grew most against it. Refresh it only when the limit changes.
// Env: FOREMAN_TEST_LOCK=0 (or a truthy CI) skips the lock; FOREMAN_TEST_CONCURRENCY=N sets --test-concurrency (default
// half the cores); FOREMAN_TEST_LOCK_MAX_MINUTES (default 30) is the age after which a lock counts as stale;
// FOREMAN_TEST_LOCK_DIR overrides the lock directory (default <agentDir>/pi-foreman/state, else the temp dir).
// The command's env has the running-session variables of extensions/core-adapter/test/session-env.json removed (the lock reads its own env first).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutSessionEnv } from "./session_env.mjs";

// Spawn guard (node mode only): the run names a temp dir in FOREMAN_SPAWN_COUNT_DIR; the test preload
// (extensions/core-adapter/test/_spawn-count.mjs) writes one file of child-process counts per test process. A run that passed
// but started any npm, or more child processes than the budget, fails. FOREMAN_TEST_SPAWN_BUDGET overrides the budget.
// Measured 2026-11-18 on macOS: 21515 child processes in a full `npm run test:node` run (git 16813, python 4509, node 62, npm 0, other 131).
// The limit is the owner's decision of 2026-11-18: the measurement plus a 10 % margin, rounded up to the next 100 (23700), capped at 22600; one number for the whole node run.
// The owner's hotfix of 2026-11-18 raised the cap to 23400 for the per-checkout review gate (about 22870 measured after round report-fixes-5's new tests, plus about 500 headroom; runs vary by several hundred); growth beyond it is a decision.
// The per-file counts are committed in scripts/foreman_test_spawn_baseline.json; `npm run test:node:baseline` refreshes it, only when the limit changes. On a run over the budget the runner lists the files that grew most against it.
// The permission clean-up round is expected to lower the limit (about 6,500 starts sit in the code it removes or rewrites).
export const DEFAULT_SPAWN_BUDGET = 23400;

export const SPAWN_BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "foreman_test_spawn_baseline.json");
export const BASELINE_COMMAND = "npm run test:node:baseline";

const OPTIONS_WITH_VALUE = new Set(["--import", "--require", "-r", "--loader", "--env-file"]);
const POLL_MS = 2000;

/** `--test-concurrency` value: FOREMAN_TEST_CONCURRENCY when a positive integer, else half the cores (at least 1). */
export function testConcurrency({ env = process.env, cores = os.availableParallelism() } = {}) {
  const v = env.FOREMAN_TEST_CONCURRENCY;
  if (v !== undefined && /^\s*[1-9]\d*\s*$/.test(v)) return Number(v);
  return Math.max(1, Math.floor(cores / 2));
}

/** The child-process budget: FOREMAN_TEST_SPAWN_BUDGET when a non-negative integer, else the default. */
export function spawnBudget(env = process.env) {
  const v = env.FOREMAN_TEST_SPAWN_BUDGET;
  return v !== undefined && /^\s*\d+\s*$/.test(v) ? Number(v) : DEFAULT_SPAWN_BUDGET;
}

/** Sums per-process count objects ({ git: 2, npm: 1, ... }) into totals by git, python, node, npm and other. */
export function sumSpawnCounts(records) {
  const t = { git: 0, python: 0, node: 0, npm: 0, other: 0, total: 0 };
  for (const r of records) {
    for (const [k, n] of Object.entries(r ?? {})) {
      if (!Number.isInteger(n) || n < 0) continue;
      t[k in t && k !== "total" ? k : "other"] += n;
      t.total += n;
    }
  }
  return t;
}

/** The npm starts per test file, largest first: [[file, n], ...]; records without a file (older shape) are "(no file)". */
export function npmCountsByFile(records) {
  const byFile = new Map();
  for (const r of records) {
    const n = r?.npm;
    if (!Number.isInteger(n) || n <= 0) continue;
    const file = typeof r.file === "string" ? r.file : "(no file)";
    byFile.set(file, (byFile.get(file) ?? 0) + n);
  }
  return [...byFile].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** The per-process count files in `dir`, parsed; unreadable files are skipped. */
export function readSpawnCounts(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {}
  }
  return out;
}

export function spawnSummaryLine(t) {
  return `child processes: ${t.total} (git ${t.git}, python ${t.python}, node ${t.node}, npm ${t.npm}, other ${t.other})`;
}

/** Why a run that exited with `code` fails the guard: a list of reasons, empty when it passes (or the run failed already). `npmFiles` is npmCountsByFile's list. */
export function spawnGuardFailures(code, t, budget, npmFiles = []) {
  if (code !== 0) return [];
  const out = [];
  if (t.npm > 0) {
    out.push(`the test run started npm ${t.npm} time(s); tests must not start npm (see docs/development.md)`);
    for (const [file, n] of npmFiles) out.push(`  npm ${n} in ${file}`);
  }
  if (t.total > budget) out.push(`the test run started ${t.total} child processes, over the budget of ${budget}`);
  return out;
}

/** Takes the runner's own flag off argv: only a leading `--write-spawn-baseline`; anywhere else it is left for node. */
export function splitRunnerFlags(argv) {
  if (argv[0] === "--write-spawn-baseline") return { writeBaseline: true, rest: argv.slice(1) };
  return { writeBaseline: false, rest: argv };
}

/** A count record's file label with `/` separators (a baseline written on one OS compares on another). */
const normalizeLabel = (file) => String(file).replace(/\\/g, "/");

/** The child-process total per test file: { label: n }; records without a file (older shape) are "(no file)". */
export function spawnCountsByFile(records) {
  const byFile = {};
  for (const r of records) {
    const label = typeof r?.file === "string" ? normalizeLabel(r.file) : "(no file)";
    let n = 0;
    for (const [k, v] of Object.entries(r ?? {})) if (k !== "file" && Number.isInteger(v) && v >= 0) n += v;
    if (n > 0) byFile[label] = (byFile[label] ?? 0) + n;
  }
  return byFile;
}

/** The files whose count grew against the baseline, largest growth first, at most `n`: [{ file, now, baseline, delta, isNew }]. Files missing from the baseline count fully and are new; equal or shrunk files are left out. */
export function spawnGrowth(byFile, baseline, n = 10) {
  const out = [];
  for (const [file, now] of Object.entries(byFile)) {
    const isNew = !Object.hasOwn(baseline, file);
    const base = isNew ? 0 : baseline[file];
    if (now > base) out.push({ file, now, baseline: base, delta: now - base, isNew });
  }
  out.sort((a, b) => b.delta - a.delta || (a.file < b.file ? -1 : 1));
  return out.slice(0, n);
}

/** The baseline's `files` map from `file`, or null when it is missing, unparsable or of the wrong shape (a `files` that is not a plain object, or a count that is not a non-negative integer). */
export function readSpawnBaseline(file) {
  try {
    const files = JSON.parse(fs.readFileSync(file, "utf8"))?.files;
    if (files === null || typeof files !== "object" || Array.isArray(files)) return null;
    for (const v of Object.values(files)) if (!Number.isInteger(v) || v < 0) return null;
    return files;
  } catch {
    return null;
  }
}

/** The text printed after a budget failure: the growth list (or why there is none) and how to refresh the baseline. `baseline` is readSpawnBaseline's result. */
export function spawnGrowthLines(growth, baseline) {
  if (baseline === null) return ["the per-file baseline is missing or unreadable, so no growth list (scripts/foreman_test_spawn_baseline.json)"];
  const lines = growth.map((g) => (g.isNew ? `  +${g.delta} ${g.file} (new)` : `  +${g.delta} ${g.file} (now ${g.now}, baseline ${g.baseline})`));
  lines.push(`refresh the list with: ${BASELINE_COMMAND} (only when the limit changes)`);
  return lines;
}

/** Whether a run writes the baseline: it exited 0 (also when over the budget) and the flag was given. */
export function shouldWriteBaseline(code, flag) {
  return flag === true && code === 0;
}

/** The node argv for a test run: leading options, then `--test --test-concurrency=N`, then the globs. */
export function nodeTestArgs(args, concurrency) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  return [...args.slice(0, i), "--test", `--test-concurrency=${concurrency}`, ...args.slice(i)];
}

/** Whether the lock is skipped: FOREMAN_TEST_LOCK=0 or a truthy CI. */
export function lockDisabled(env = process.env) {
  if (env.FOREMAN_TEST_LOCK === "0") return true;
  const ci = (env.CI ?? "").toLowerCase();
  return ci !== "" && ci !== "0" && ci !== "false";
}

export function lockPath(env = process.env) {
  if (env.FOREMAN_TEST_LOCK_DIR) return path.join(env.FOREMAN_TEST_LOCK_DIR, "test-lock");
  let agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  if (agentDir === "~" || agentDir.startsWith("~/") || agentDir.startsWith("~\\")) agentDir = path.join(os.homedir(), agentDir.slice(1));
  agentDir = path.resolve(agentDir);
  const dir = fs.existsSync(agentDir) ? path.join(agentDir, "pi-foreman", "state") : os.tmpdir();
  return path.join(dir, "test-lock");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLock(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    const started = Date.parse(info?.started);
    if (Number.isInteger(info?.pid) && info.pid > 0 && !Number.isNaN(started)) return { pid: info.pid, started };
  } catch {}
  return undefined;
}

/** Why the lock file is stale (dead holder, too old, unreadable for a few seconds), else undefined. */
function staleReason(file, maxMs, now = Date.now()) {
  const info = readLock(file);
  if (!info) {
    try {
      return now - fs.statSync(file).mtimeMs > 5000 ? "unreadable" : undefined;
    } catch {
      return undefined;
    }
  }
  if (!pidAlive(info.pid)) return "dead";
  if (now - info.started > maxMs) return "old";
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Takes the lock (waiting while another live run holds it) and returns a release function. */
export async function acquireLock(file, { maxMinutes = 30, pollMs = POLL_MS, stderr = process.stderr } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const maxMs = maxMinutes * 60_000;
  const body = JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cwd: process.cwd(), host: os.hostname() });
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(file, body, { flag: "wx" });
      return () => {
        if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (staleReason(file, maxMs)) {
      // Takeovers are serialised by a short-lived mutex: staleness is re-checked while holding it, so a live lock that
      // another waiter created after our first check is never removed. A mutex older than 10 s counts as abandoned.
      const mutex = `${file}.takeover`;
      let held = false;
      try {
        fs.writeFileSync(mutex, String(process.pid), { flag: "wx" });
        held = true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) fs.rmSync(mutex, { force: true });
        } catch {}
      }
      if (held) {
        try {
          if (staleReason(file, maxMs)) fs.rmSync(file, { force: true });
        } finally {
          fs.rmSync(mutex, { force: true });
        }
        continue;
      }
      await sleep(Math.min(pollMs, 50));
      continue;
    }
    if (!announced) {
      const info = readLock(file);
      if (info) {
        const d = new Date(info.started);
        const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        stderr.write(`waiting for the test lock held by pid ${info.pid}, started ${hhmm}\n`);
        announced = true;
      }
    }
    await sleep(pollMs);
  }
}

async function main(rawArgv, env = process.env) {
  const { writeBaseline, rest: argv } = splitRunnerFlags(rawArgv);
  let cmd;
  let args;
  if (argv[0] === "--exec") {
    const rest = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
    if (!rest.length) {
      process.stderr.write("usage: foreman_test_run.mjs --exec -- <command> [args...]\n");
      return 2;
    }
    [cmd, ...args] = rest;
  } else {
    cmd = process.execPath;
    args = nodeTestArgs(argv, testConcurrency({ env }));
  }
  let release = () => {};
  if (!lockDisabled(env)) {
    release = await acquireLock(lockPath(env), { maxMinutes: Number(env.FOREMAN_TEST_LOCK_MAX_MINUTES) > 0 ? Number(env.FOREMAN_TEST_LOCK_MAX_MINUTES) : 30 });
  }
  const countDir = argv[0] === "--exec" ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "pf-spawn-count-"));
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: countDir ? { ...withoutSessionEnv(env), FOREMAN_SPAWN_COUNT_DIR: countDir } : withoutSessionEnv(env), shell: false });
    const forward = (sig) => () => child.kill(sig);
    const handlers = ["SIGINT", "SIGTERM"].map((s) => [s, forward(s)]);
    for (const [s, h] of handlers) process.on(s, h);
    const done = (code) => {
      for (const [s, h] of handlers) process.off(s, h);
      release();
      resolve(code);
    };
    child.on("error", (e) => {
      process.stderr.write(`foreman_test_run: ${e.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) => done(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1)));
  });
  if (!countDir) return code;
  try {
    const records = readSpawnCounts(countDir);
    const totals = sumSpawnCounts(records);
    process.stdout.write(`${spawnSummaryLine(totals)}\n`);
    const failures = spawnGuardFailures(code, totals, spawnBudget(env), npmCountsByFile(records));
    for (const f of failures) process.stderr.write(`foreman_test_run: ${f}\n`);
    const byFile = spawnCountsByFile(records);
    if (code === 0 && totals.total > spawnBudget(env)) {
      const baseline = readSpawnBaseline(SPAWN_BASELINE_FILE);
      for (const l of spawnGrowthLines(baseline ? spawnGrowth(byFile, baseline) : [], baseline)) process.stderr.write(`foreman_test_run: ${l}\n`);
    }
    if (shouldWriteBaseline(code, writeBaseline)) {
      const sorted = Object.fromEntries(Object.entries(byFile).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      fs.writeFileSync(SPAWN_BASELINE_FILE, `${JSON.stringify({ measured: new Date().toISOString().slice(0, 10), files: sorted }, null, 2)}\n`);
      process.stdout.write(`wrote ${SPAWN_BASELINE_FILE}\n`);
    }
    return failures.length ? 1 : code;
  } finally {
    fs.rmSync(countDir, { recursive: true, force: true });
  }
}

function realPath(p) {
  let r;
  try {
    r = fs.realpathSync.native(p);
  } catch {
    r = path.resolve(p);
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  // A signal while waiting for the lock ends the process; nothing is held yet.
  process.exitCode = await main(process.argv.slice(2));
}
