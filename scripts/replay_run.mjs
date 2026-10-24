#!/usr/bin/env node
// `node scripts/replay_run.mjs`: the replay suite (tests/replay/test_*.py), run as one `python -m unittest` per module.
// Modules run in a pool of FOREMAN_REPLAY_JOBS workers (default min(4, availableParallelism)); SERIAL modules run one by one
// after the pool. Prints one PASS|FAIL line per module, the slowest 15, the wall time and the last 80 lines of each failure.
// Exits 0 when every module passed, 1 when one failed, 2 when no module was found or the arguments are wrong.
// Options (for tests): --dir <path> replaces tests/replay, --serial a,b replaces the SERIAL list (module stems).
// The interpreter is PI_FOREMAN_PYTHON, else python on Windows and python3 elsewhere.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Modules that cannot share the machine with the pool: they start processes that wait on fixed timing windows.
const SERIAL = ["test_replay_intercom", "test_replay_presence", "test_replay_session_tree"];
const TAIL_LINES = 80;
const SLOWEST = 15;

function usage(message) {
  console.error(`${message}\nusage: node scripts/replay_run.mjs [--dir <path>] [--serial a,b]`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { dir: path.join(root, "tests", "replay"), serial: SERIAL };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--dir" && value !== undefined) {
      opts.dir = path.resolve(root, value);
      i += 1;
    } else if (argv[i] === "--serial" && value !== undefined) {
      opts.serial = value.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else {
      usage(`unknown or incomplete argument ${argv[i]}`);
    }
  }
  return opts;
}

function poolSize() {
  const raw = process.env.FOREMAN_REPLAY_JOBS;
  if (raw === undefined || raw === "") return Math.min(4, os.availableParallelism());
  if (!/^[1-9]\d*$/.test(raw)) usage(`FOREMAN_REPLAY_JOBS must be a positive integer, got ${raw}`);
  return Number(raw);
}

/** Runs one module with unittest and resolves with its verdict, test count, wall seconds and combined output. */
function runModule(py, dir, file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    let spawnError = null;
    const child = spawn(py, ["-m", "unittest", "discover", "-s", dir, "-p", file, "-v"], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (e) => {
      spawnError = e;
    });
    child.on("close", (code) => {
      const out = chunks.join("") + (spawnError ? `\n${spawnError.message}\n` : "");
      const ran = /^Ran (\d+) tests? in /m.exec(out);
      resolve({
        module: file.replace(/\.py$/, ""),
        ok: code === 0 && spawnError === null,
        tests: ran ? Number(ran[1]) : 0,
        secs: (Date.now() - started) / 1000,
        out,
      });
    });
  });
}

function report(result) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.module} ${result.tests} tests ${result.secs.toFixed(1)}s`);
}

/** Runs the modules with at most `jobs` in flight; each finished module is reported as it completes. */
async function runPool(py, dir, files, jobs, results) {
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const result = await runModule(py, dir, file);
      report(result);
      results.push(result);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jobs = poolSize();
  const py = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const all = fs.existsSync(opts.dir)
    ? fs.readdirSync(opts.dir).filter((f) => /^test_.*\.py$/.test(f)).sort()
    : [];
  if (all.length === 0) {
    console.error(`no replay modules (test_*.py) found in ${opts.dir}`);
    return 2;
  }
  const serialFiles = opts.serial.map((m) => `${m}.py`).filter((f) => all.includes(f));
  const poolFiles = all.filter((f) => !serialFiles.includes(f));

  const started = Date.now();
  const results = [];
  await runPool(py, opts.dir, poolFiles, jobs, results);
  for (const file of serialFiles) {
    const result = await runModule(py, opts.dir, file);
    report(result);
    results.push(result);
  }
  const wall = (Date.now() - started) / 1000;

  console.log(`\nslowest ${SLOWEST} modules:`);
  console.log(`  ${"secs".padStart(7)}  ${"tests".padStart(5)}  status  module`);
  for (const r of [...results].sort((a, b) => b.secs - a.secs).slice(0, SLOWEST)) {
    console.log(`  ${r.secs.toFixed(1).padStart(7)}  ${String(r.tests).padStart(5)}  ${(r.ok ? "PASS" : "FAIL").padEnd(6)}  ${r.module}`);
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    const lines = r.out.trimEnd().split("\n");
    console.log(`\n--- FAIL ${r.module}: last ${TAIL_LINES} lines ---`);
    console.log(lines.slice(-TAIL_LINES).join("\n"));
  }

  const passed = results.length - failed.length;
  console.log(`\nreplay modules: ${passed} passed, ${failed.length} failed (${results.length} modules, ${jobs} workers, ${serialFiles.length} serial, wall ${wall.toFixed(1)}s)`);
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main();
