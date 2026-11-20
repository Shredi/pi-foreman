// Runs a test suite behind a machine-wide lock so parallel sessions queue instead of overloading the host.
// Usage: node scripts/foreman_test_run.mjs [--timeout <s>] <node args and globs...>      -> node <leading options> --test --test-concurrency=N <globs>
//        node scripts/foreman_test_run.mjs [--timeout <s>] --exec -- <command> [args...]  -> the command, lock only (no concurrency flag)
// Time limit: a leading `--timeout <s>` or env FOREMAN_TEST_TIMEOUT=<s> (flag wins; positive number, fractions allowed) is one deadline
// for the lock wait plus the run, also with the lock off. When it passes, the run and its descendants are stopped (SIGTERM, after 5 s
// SIGKILL; Windows taskkill /T /F), the lock is released, one stderr line names limit, elapsed time and the holder waited on; exit 124.
// A bad value exits 2 with nothing run. The wait for the lock ends after FOREMAN_TEST_LOCK_WAIT_MINUTES (default 20): exit 75, nothing run.
// Leading node options (`--import ./x.mjs`, other `-x` flags) stay before `--test`; the first plain argument starts the globs.
// Env: FOREMAN_TEST_LOCK=0 (or a truthy CI) skips the lock; FOREMAN_TEST_CONCURRENCY=N sets --test-concurrency (default
// half the cores); FOREMAN_TEST_LOCK_MAX_MINUTES (default 30) is the age after which a lock counts as stale;
// FOREMAN_TEST_LOCK_DIR overrides the lock directory (default <agentDir>/pi-foreman/state, else the temp dir).
// The command's env has the running-session variables of extensions/core-adapter/test/session-env.json removed (the lock reads its own env first).
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutSessionEnv } from "./session_env.mjs";

// Spawn guard (node mode only): the run names a temp dir in FOREMAN_SPAWN_COUNT_DIR; the test preload
// (extensions/core-adapter/test/_spawn-count.mjs) writes one file of child-process counts per test process, and the CJS preload
// _proc-watch.cjs (put in the run's NODE_OPTIONS) writes a title record for a node process that changed its process title and
// stops a process whose wrapper died. A run that passed but started any npm, or had a titled node process, fails; there is no
// limit on the total count. Async children still running when a test process ended are listed as a warning only.
const PROC_WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions", "core-adapter", "test", "_proc-watch.cjs");

const OPTIONS_WITH_VALUE = new Set(["--import", "--require", "-r", "--loader", "--env-file"]);
const POLL_MS = 250;
const TICKET_STALE_MS = 30_000;

/** `--test-concurrency` value: FOREMAN_TEST_CONCURRENCY when a positive integer, else half the cores (at least 1). */
export function testConcurrency({ env = process.env, cores = os.availableParallelism() } = {}) {
  const v = env.FOREMAN_TEST_CONCURRENCY;
  if (v !== undefined && /^\s*[1-9]\d*\s*$/.test(v)) return Number(v);
  return Math.max(1, Math.floor(cores / 2));
}

/** NODE_OPTIONS for a node-mode run: the existing value kept, then `--require=<preload>`; JSON quoting escapes `\` and `"` the way node's parser reads them. */
export function nodeOptionsWithWatch(existing, preload = PROC_WATCH) {
  const req = `--require=${JSON.stringify(path.resolve(preload))}`;
  if (!existing) return req;
  return existing.includes(req) ? existing : `${existing} ${req}`;
}

/** The env of a node-mode run: the count dir, the watch preload in NODE_OPTIONS and this process as the wrapper pid. */
export function nodeRunEnv(env, countDir, wrapperPid = process.pid) {
  return { ...withoutSessionEnv(env), FOREMAN_SPAWN_COUNT_DIR: countDir, NODE_OPTIONS: nodeOptionsWithWatch(env.NODE_OPTIONS), FOREMAN_TEST_WRAPPER_PID: String(wrapperPid) };
}

/** Record fields that are not child counts. */
const NON_COUNT_FIELDS = new Set(["titled", "leftovers", "file"]);

/** Sums per-process count objects ({ git: 2, npm: 1, ... }) into totals by git, python, node, npm and other. */
export function sumSpawnCounts(records) {
  const t = { git: 0, python: 0, node: 0, npm: 0, other: 0, total: 0 };
  for (const r of records) {
    for (const [k, n] of Object.entries(r ?? {})) {
      if (NON_COUNT_FIELDS.has(k) || !Number.isInteger(n) || n < 0) continue;
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

/** The files that had a node process with a changed process title, sorted, without repeats. */
export function titledFiles(records) {
  const files = new Set();
  for (const r of records) if (r?.titled === true) files.add(typeof r.file === "string" ? r.file : "(no file)");
  return [...files].sort();
}

/** Why a run that exited with `code` fails the guard: a list of reasons, empty when it passes (or the run failed already). `npmFiles` is npmCountsByFile's list, `titled` is titledFiles' list. */
export function spawnGuardFailures(code, t, npmFiles = [], titled = []) {
  if (code !== 0) return [];
  const out = [];
  if (t.npm > 0) {
    out.push(`the test run started npm ${t.npm} time(s); tests must not start npm (see docs/development.md)`);
    for (const [file, n] of npmFiles) out.push(`  npm ${n} in ${file}`);
  }
  if (titled.length > 0) {
    out.push(`the test run had ${titled.length} file(s) with a node process that changed its process title; tests must not (see docs/development.md)`);
    for (const file of titled) out.push(`  titled node process in ${file}`);
  }
  return out;
}

/** The warning lines for async children still running when a test process ended: empty when none, else a header and one line per file with count and kinds. */
export function leftoverLines(records) {
  const byFile = new Map();
  for (const r of records) {
    if (!Array.isArray(r?.leftovers) || r.leftovers.length === 0) continue;
    const file = typeof r.file === "string" ? r.file : "(no file)";
    const e = byFile.get(file) ?? { n: 0, kinds: new Set() };
    for (const k of r.leftovers) {
      e.n += 1;
      e.kinds.add(String(k));
    }
    byFile.set(file, e);
  }
  if (byFile.size === 0) return [];
  const lines = [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([file, e]) => `  ${file}: ${e.n} (${[...e.kinds].sort().join(", ")})`);
  return ["warning: child processes still running when a test process ended:", ...lines];
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
    if (Number.isInteger(info?.pid) && info.pid > 0 && !Number.isNaN(started)) return { pid: info.pid, started, cwd: typeof info.cwd === "string" ? info.cwd : undefined };
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

let ticketCounter = 0;
const TICKET_NAME = /^(\d{15})-(\d+)-(\d+)\.json$/;

/** Writes this waiter's ticket in `dir` (named by arrival time, so sorted names are arrival order) and returns its name. */
function writeTicket(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (;;) {
    const name = `${String(Date.now()).padStart(15, "0")}-${String(ticketCounter++).padStart(6, "0")}-${process.pid}.json`;
    try {
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, cwd: process.cwd() }), { flag: "wx" });
      return name;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

/** Removes a ticket; false when that failed (Windows EPERM while the file is open), to retry at the next poll. */
function removeTicket(dir, name) {
  try {
    fs.rmSync(path.join(dir, name), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * One queue poll: touches `mine` (the heartbeat; writes a new ticket at the end when it is gone), drops tickets of dead pids and
 * tickets whose heartbeat is older than TICKET_STALE_MS (never by queue age), and returns {mine, first}: first is true when
 * `mine` is the first live ticket.
 */
function pollQueue(dir, mine, now = Date.now()) {
  try {
    const t = new Date(now);
    fs.utimesSync(path.join(dir, mine), t, t);
  } catch (e) {
    if (e.code === "ENOENT") mine = writeTicket(dir);
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => TICKET_NAME.test(n)).sort();
  } catch {}
  for (const n of names) {
    if (n === mine) continue;
    let stale = !pidAlive(Number(TICKET_NAME.exec(n)[3]));
    if (!stale) {
      try {
        stale = now - fs.statSync(path.join(dir, n)).mtimeMs > TICKET_STALE_MS;
      } catch {
        continue;
      }
    }
    // a ticket that could not be removed is ignored now and retried at the next poll
    if (stale) {
      removeTicket(dir, n);
      names = names.filter((x) => x !== n);
    }
  }
  return { mine, first: names[0] === mine };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown by acquireLock when `maxWaitMs` passed while a live run held the lock; `holder` is {pid, started, cwd} or undefined. */
export class LockWaitTimeout extends Error {
  constructor(holder, waitedMs) {
    super("timed out waiting for the test lock");
    this.name = "LockWaitTimeout";
    this.holder = holder;
    this.waitedMs = waitedMs;
  }
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** `pid N (cwd X), started HH:MM` for a lock holder. */
export function holderText(h) {
  return `pid ${h.pid} (cwd ${h.cwd ?? "unknown"}), started ${hhmm(h.started)}`;
}

const minutes = (ms) => Number((ms / 60_000).toFixed(1));

/**
 * Takes the lock (waiting while another live run holds it) and returns a release function. A wait line names the holder at
 * the start and again every `announceMs`; `onHolder(holder)` gets each holder waited on; after `maxWaitMs` (unbounded when unset)
 * it throws LockWaitTimeout.
 */
export async function acquireLock(file, { maxMinutes = 30, pollMs = POLL_MS, stderr = process.stderr, maxWaitMs, announceMs = 60_000, onHolder } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const maxMs = maxMinutes * 60_000;
  const body = JSON.stringify({ pid: process.pid, started: new Date().toISOString(), cwd: process.cwd(), host: os.hostname() });
  let waitStart;
  let lastAnnounce;
  let holder;
  const queueDir = `${file}.queue`;
  let ticket = writeTicket(queueDir);
  const dropTicket = () => removeTicket(queueDir, ticket);
  process.once("exit", dropTicket);
  for (;;) {
    const q = pollQueue(queueDir, ticket);
    ticket = q.mine;
    if (q.first) {
      try {
        fs.writeFileSync(file, body, { flag: "wx" });
        if (dropTicket()) process.removeListener("exit", dropTicket);
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
    }
    const now = Date.now();
    waitStart ??= now;
    const info = readLock(file);
    if (info) {
      holder = info;
      onHolder?.(info);
      if (lastAnnounce === undefined) {
        stderr.write(`waiting for the test lock held by ${holderText(info)}\n`);
        lastAnnounce = now;
      } else if (now - lastAnnounce >= announceMs) {
        stderr.write(`still waiting for the test lock held by ${holderText(info)}; waited ${minutes(now - waitStart)} min\n`);
        lastAnnounce = now;
      }
    }
    const left = maxWaitMs === undefined ? Infinity : maxWaitMs - (now - waitStart);
    if (left <= 0) {
      dropTicket();
      process.removeListener("exit", dropTicket);
      throw new LockWaitTimeout(holder, now - waitStart);
    }
    await sleep(Math.min(pollMs, left));
  }
}

/** Positive finite seconds from a string, else undefined. */
function positiveNumber(v) {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The pid and parent pid of every process, [{pid, ppid}, ...], from `ps -A -o pid= -o ppid=`; undefined when ps fails. */
export function listProcesses(run = spawnSync) {
  try {
    const r = run("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return undefined;
    const out = [];
    for (const line of r.stdout.split("\n")) {
      const m = line.trim().split(/\s+/).map(Number);
      if (m.length === 2 && Number.isInteger(m[0]) && Number.isInteger(m[1])) out.push({ pid: m[0], ppid: m[1] });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The pids of `root` and all its descendants in a process listing. */
function treeOf(root, procs) {
  const set = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { pid, ppid } of procs) {
      if (set.has(ppid) && !set.has(pid)) {
        set.add(pid);
        grew = true;
      }
    }
  }
  return set;
}

/**
 * Stops `pid` and its descendants without a process group. POSIX: list processes, SIGTERM the tree, wait `graceMs`, list again
 * and SIGKILL the union of both listings unconditionally (a ps failure: the child only, with a note). Windows: taskkill /T /F.
 */
export async function killTree(pid, { platform = process.platform, spawnSync: run = spawnSync, kill = process.kill.bind(process), list = () => listProcesses(run), graceMs = 5000, stderr = process.stderr, env = process.env } = {}) {
  if (platform === "win32") {
    const taskkill = env.SystemRoot ? path.win32.join(env.SystemRoot, "System32", "taskkill.exe") : "taskkill";
    try {
      run(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  const signal = (pids, sig) => {
    for (const p of pids) {
      try {
        kill(p, sig);
      } catch {}
    }
  };
  const first = list();
  if (!first) stderr.write("foreman_test_run: could not list processes; stopping the main test process only\n");
  const targets = first ? treeOf(pid, first) : new Set([pid]);
  signal(targets, "SIGTERM");
  await sleep(graceMs);
  const second = list();
  const all = new Set(targets);
  if (second) for (const p of treeOf(pid, second)) all.add(p);
  signal(all, "SIGKILL");
}

async function main(rawArgv, env = process.env) {
  const started = Date.now();
  let argv = rawArgv;
  let limitS;
  if (argv[0] === "--timeout") {
    limitS = positiveNumber(argv[1]);
    if (limitS === undefined) {
      process.stderr.write("foreman_test_run: --timeout needs a positive number of seconds\n");
      return 2;
    }
    argv = argv.slice(2);
  } else if (env.FOREMAN_TEST_TIMEOUT !== undefined && env.FOREMAN_TEST_TIMEOUT.trim() !== "") {
    limitS = positiveNumber(env.FOREMAN_TEST_TIMEOUT);
    if (limitS === undefined) {
      process.stderr.write("foreman_test_run: FOREMAN_TEST_TIMEOUT needs a positive number of seconds\n");
      return 2;
    }
  }
  const limitMs = limitS === undefined ? undefined : limitS * 1000;
  const elapsedS = () => ((Date.now() - started) / 1000).toFixed(1);
  let cmd;
  let args;
  if (argv[0] === "--exec") {
    const rest = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
    if (!rest.length) {
      process.stderr.write("usage: foreman_test_run.mjs [--timeout <s>] --exec -- <command> [args...]\n");
      return 2;
    }
    [cmd, ...args] = rest;
  } else {
    cmd = process.execPath;
    args = nodeTestArgs(argv, testConcurrency({ env }));
  }
  let release = () => {};
  let holder;
  const limitLine = () =>
    `foreman_test_run: time limit of ${limitS} s reached after ${elapsedS()} s; stopped the run${holder ? `; waited for the lock held by ${holderText(holder)}` : ""}\n`;
  if (!lockDisabled(env)) {
    const waitMin = Number(env.FOREMAN_TEST_LOCK_WAIT_MINUTES) > 0 ? Number(env.FOREMAN_TEST_LOCK_WAIT_MINUTES) : 20;
    const maxWaitMs = Math.min(waitMin * 60_000, limitMs === undefined ? Infinity : limitMs - (Date.now() - started));
    try {
      release = await acquireLock(lockPath(env), {
        maxMinutes: Number(env.FOREMAN_TEST_LOCK_MAX_MINUTES) > 0 ? Number(env.FOREMAN_TEST_LOCK_MAX_MINUTES) : 30,
        maxWaitMs,
        onHolder: (h) => (holder = h),
      });
    } catch (e) {
      if (!(e instanceof LockWaitTimeout)) throw e;
      if (limitMs !== undefined && Date.now() - started >= limitMs) {
        process.stderr.write(limitLine());
        return 124;
      }
      process.stderr.write(`foreman_test_run: gave up waiting for the test lock after ${minutes(e.waitedMs)} min; held by ${e.holder ? holderText(e.holder) : "an unknown run"}\n`);
      return 75;
    }
  }
  const countDir = argv[0] === "--exec" ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "pf-spawn-count-"));
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: countDir ? nodeRunEnv(env, countDir) : withoutSessionEnv(env), shell: false });
    const forward = (sig) => () => child.kill(sig);
    const handlers = ["SIGINT", "SIGTERM"].map((s) => [s, forward(s)]);
    for (const [s, h] of handlers) process.on(s, h);
    let timer;
    let killing; // the kill step of a fired time limit; the lock is released only after it
    const done = async (code) => {
      clearTimeout(timer);
      if (killing) await killing;
      for (const [s, h] of handlers) process.off(s, h);
      release();
      resolve(killing ? 124 : code);
    };
    if (limitMs !== undefined) {
      timer = setTimeout(() => {
        process.stderr.write(limitLine());
        killing = killTree(child.pid);
      }, Math.max(0, limitMs - (Date.now() - started)));
    }
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
    const failures = spawnGuardFailures(code, totals, npmCountsByFile(records), titledFiles(records));
    for (const f of failures) process.stderr.write(`foreman_test_run: ${f}\n`);
    for (const l of leftoverLines(records)) process.stderr.write(`foreman_test_run: ${l}\n`);
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
