// Runs a test suite behind a machine-wide lock so parallel sessions queue instead of overloading the host.
// Usage: node scripts/foreman_test_run.mjs [--timeout <s>] <node args and globs...>      -> node <leading options> --test --test-concurrency=N <globs>
//        node scripts/foreman_test_run.mjs [--timeout <s>] --targeted <node args and globs/files...>  -> the same behind a shared slot
//        node scripts/foreman_test_run.mjs [--timeout <s>] --exec -- <command> [args...]  -> the command, lock only (no concurrency flag)
// Time limit: a leading `--timeout <s>` or env FOREMAN_TEST_TIMEOUT=<s> (flag wins; positive number, fractions allowed) is one deadline
// for the lock wait plus the run, also with the lock off. When it passes, the run and its descendants are stopped (SIGTERM, after 5 s
// SIGKILL; Windows taskkill /T /F), the lock is released, one stderr line names limit, elapsed time and the holder waited on; exit 124.
// A bad value exits 2 with nothing run. The wait for the lock ends after FOREMAN_TEST_LOCK_WAIT_MINUTES (default 20) without progress
// (the wait counter restarts whenever the holder changes): exit 75, nothing run.
// Every run prints one stderr line with its run id and keeps a record <lockdir>/test-runs/<id>.json (removed on exit). `--stop <id>` writes
// <id>.stop, which the run polls (waiting or running): a queued run leaves the queue, a running run's tree is stopped and the lock released;
// the stopped run exits 130. `--stop-cwd` stops this worktree's runs only; `--list` prints the holder and the runs. No signals, no pattern kill.
// The holder touches the lock file every 5 s (heartbeat); a lock is stale when its pid is dead or the heartbeat is older than 60 s (a lock without an id, written by the old wrapper, instead when `started` is older than the max minutes). A live
// holder is never taken over: it caps its own run at FOREMAN_TEST_LOCK_MAX_MINUTES (default 30) and exits 124.
// `--targeted <node args and globs/files...>` is a node-mode run that takes one of FOREMAN_TEST_TARGETED_SLOTS (default 2) machine-wide
// shared slots (<lockdir>/test-slot-<k>, one queue) instead of the exclusive lock, so it never waits for or blocks a full-suite run; its
// --test-concurrency is max(1, cores / FOREMAN_TEST_TARGETED_SHARE) (default share 4); FOREMAN_TEST_CONCURRENCY does not apply to it.
// Same run id, record (mode targeted|suite), --stop, heartbeat/stale takeover, run cap and wait limits as the full-suite lock.
// Leading node options (`--import ./x.mjs`, other `-x` flags) stay before `--test`; the first plain argument starts the globs.
// Env: FOREMAN_TEST_LOCK=0 (or a truthy CI) skips the lock; FOREMAN_TEST_CONCURRENCY=N sets --test-concurrency (default
// half the cores); FOREMAN_TEST_LOCK_MAX_MINUTES (default 30) is the run cap of the lock holder;
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
const HEARTBEAT_MS = 5000;
const HEARTBEAT_STALE_MS = 60_000;
const STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 200;

/** `--test-concurrency` value: FOREMAN_TEST_CONCURRENCY when a positive integer, else half the cores (at least 1). */
export function testConcurrency({ env = process.env, cores = os.availableParallelism() } = {}) {
  const v = env.FOREMAN_TEST_CONCURRENCY;
  if (v !== undefined && /^\s*[1-9]\d*\s*$/.test(v)) return Number(v);
  return Math.max(1, Math.floor(cores / 2));
}

/** Targeted mode: {slots, concurrency}; FOREMAN_TEST_TARGETED_SLOTS (default 2) and FOREMAN_TEST_TARGETED_SHARE (default 4) when positive integers, concurrency = max(1, floor(cores / share)). */
export function targetedSettings({ env = process.env, cores = os.availableParallelism() } = {}) {
  const pos = (v, d) => (v !== undefined && /^\s*[1-9]\d*\s*$/.test(v) ? Number(v) : d);
  const slots = pos(env.FOREMAN_TEST_TARGETED_SLOTS, 2);
  const share = pos(env.FOREMAN_TEST_TARGETED_SHARE, 4);
  return { slots, concurrency: Math.max(1, Math.floor(cores / share)) };
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

/** The slot files of targeted mode: <lockdir>/test-slot-<k>, k = 0..slots-1. */
export function slotPaths(env = process.env, slots = targetedSettings({ env }).slots) {
  const dir = path.dirname(lockPath(env));
  return Array.from({ length: slots }, (_, k) => path.join(dir, `test-slot-${k}`));
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
    if (Number.isInteger(info?.pid) && info.pid > 0 && !Number.isNaN(started))
      return { pid: info.pid, started, cwd: typeof info.cwd === "string" ? info.cwd : undefined, id: typeof info.id === "string" ? info.id : undefined, command: typeof info.command === "string" ? info.command : undefined };
  } catch {}
  return undefined;
}

/** Why the lock file is stale (dead holder, heartbeat older than `heartbeatStaleMs`, unreadable for a few seconds), else undefined. A live, heartbeating holder is never stale however old. A lock without an `id` (old wrapper, no heartbeat) is stale only when `started` is older than `legacyMaxMs`. */
function staleReason(file, heartbeatStaleMs, legacyMaxMs, now = Date.now()) {
  const info = readLock(file);
  if (!info) {
    try {
      return now - fs.statSync(file).mtimeMs > 5000 ? "unreadable" : undefined;
    } catch {
      return undefined;
    }
  }
  if (!pidAlive(info.pid)) return "dead";
  if (info.id === undefined) return now - info.started > legacyMaxMs ? "old" : undefined;
  try {
    if (now - fs.statSync(file).mtimeMs > heartbeatStaleMs) return "heartbeat";
  } catch {}
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
 * `mine` is the first live ticket; position is its 1-based place and total the number of live tickets.
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
  return { mine, first: names[0] === mine, position: names.indexOf(mine) + 1, total: names.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown by acquireLock when `maxWaitMs` passed while a live run held the lock; `holder` is {pid, started, cwd} or undefined; `holders` lists the holders of all slots in slot mode. */
export class LockWaitTimeout extends Error {
  constructor(holder, waitedMs, holders) {
    super("timed out waiting for the test lock");
    this.name = "LockWaitTimeout";
    this.holder = holder;
    this.holders = holders;
    this.waitedMs = waitedMs;
  }
}

/** Thrown by acquireLock when `shouldStop()` turned true while waiting; the ticket is dropped. */
export class LockStopped extends Error {
  constructor() {
    super("stopped while waiting for the test lock");
    this.name = "LockStopped";
  }
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** `run <id> (pid N, cwd X), since HH:MM: <command>` for a lock holder (`unknown` for fields an older lock file lacks). */
export function holderText(h) {
  return `run ${h.id ?? "unknown"} (pid ${h.pid}, cwd ${h.cwd ?? "unknown"}), since ${hhmm(h.started)}: ${h.command ?? "unknown"}`;
}

/** The wait line of a targeted run: `waiting for a targeted test slot (B of N busy), <place>; held by: <holder>; <holder>`. */
export function slotWaitLine(holders, slots, place) {
  return `waiting for a targeted test slot (${holders.length} of ${slots} busy), ${place}; held by: ${holders.map(holderText).join("; ")}`;
}

const minutes = (ms) => Number((ms / 60_000).toFixed(1));

/**
 * Takes the lock (waiting while another live run holds it) and returns a release function; the holder touches the lock file every
 * `heartbeatMs`, and a lock whose heartbeat is older than `heartbeatStaleMs` (or whose pid is dead) is taken over; a lock without an
 * `id` (old format, no heartbeat) only when its `started` is older than `legacyMaxMs`. A wait line
 * names the holder and the queue position at the start, when the holder changes, and every `announceMs`; `onHolder(holder)` gets
 * each holder waited on. After `maxWaitMs` (unbounded when unset) without progress (the counter restarts whenever the holder
 * changes), or at the absolute `deadlineAt` (epoch ms), it throws LockWaitTimeout. `shouldStop()` is checked every poll: when true
 * the ticket is dropped and LockStopped is thrown. `id` and `command` go into the lock file.
 * Slot mode (`files` given): one queue feeds any free file; the wait line lists all holders (see `slotWaitLine`) and
 * `onHolder` gets the holder list; `file` names the queue (`<file>.queue`) and the takeover mutex.
 */
export async function acquireLock(
  file,
  { files: slotFiles, pollMs = POLL_MS, stderr = process.stderr, maxWaitMs, deadlineAt, announceMs = 60_000, onHolder, shouldStop, id, command, heartbeatMs = HEARTBEAT_MS, heartbeatStaleMs = HEARTBEAT_STALE_MS, legacyMaxMs = 30 * 60_000 } = {},
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const slotMode = slotFiles !== undefined;
  const files = slotFiles ?? [file];
  // `started` is the moment the lock is taken, not when the wait began (old wrappers age a lock by it).
  const lockBody = () => JSON.stringify({ id, pid: process.pid, started: new Date().toISOString(), cwd: process.cwd(), command, host: os.hostname() });
  let waitStart;
  let progressStart;
  let holderKey;
  let lastAnnounce = 0;
  let holder;
  let lastHolders = [];
  const queueDir = `${file}.queue`;
  let ticket = writeTicket(queueDir);
  const dropTicket = () => removeTicket(queueDir, ticket);
  process.once("exit", dropTicket);
  for (;;) {
    if (shouldStop?.()) {
      dropTicket();
      process.removeListener("exit", dropTicket);
      throw new LockStopped();
    }
    const q = pollQueue(queueDir, ticket);
    ticket = q.mine;
    if (q.first) {
      for (const f of files) {
        try {
          fs.writeFileSync(f, lockBody(), { flag: "wx" });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
          continue;
        }
        if (dropTicket()) process.removeListener("exit", dropTicket);
        const beat = setInterval(() => {
          try {
            const t = new Date();
            fs.utimesSync(f, t, t);
          } catch {}
        }, heartbeatMs);
        beat.unref();
        return () => {
          clearInterval(beat);
          if (readLock(f)?.pid === process.pid) fs.rmSync(f, { force: true });
        };
      }
      const stale = files.filter((f) => staleReason(f, heartbeatStaleMs, legacyMaxMs));
      if (stale.length) {
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
            for (const f of stale) if (staleReason(f, heartbeatStaleMs, legacyMaxMs)) fs.rmSync(f, { force: true });
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
    progressStart ??= now;
    const place = `queue position ${q.position} of ${q.total}`;
    if (slotMode) {
      const holders = files.map((f) => readLock(f)).filter(Boolean);
      if (holders.length) {
        holder = holders[0];
        onHolder?.(holders);
        const key = holders.map((h) => h.id ?? `pid ${h.pid} ${h.started}`).join(",");
        if (key !== holderKey || now - lastAnnounce >= announceMs) {
          if (holderKey !== undefined && key !== holderKey) progressStart = now;
          holderKey = key;
          stderr.write(`${slotWaitLine(holders, files.length, place)}\n`);
          lastAnnounce = now;
        }
      }
      lastHolders = holders;
    } else {
      const info = readLock(file);
      if (info) {
        holder = info;
        onHolder?.(info);
        const key = info.id ?? `pid ${info.pid} ${info.started}`;
        if (key !== holderKey) {
          if (holderKey !== undefined) progressStart = now;
          holderKey = key;
          stderr.write(`waiting for the test lock held by ${holderText(info)}, ${place}\n`);
          lastAnnounce = now;
        } else if (now - lastAnnounce >= announceMs) {
          stderr.write(`still waiting for the test lock held by ${holderText(info)}, ${place}; waited ${minutes(now - waitStart)} min\n`);
          lastAnnounce = now;
        }
      }
    }
    const left = Math.min(maxWaitMs === undefined ? Infinity : maxWaitMs - (now - progressStart), deadlineAt === undefined ? Infinity : deadlineAt - now);
    if (left <= 0) {
      dropTicket();
      process.removeListener("exit", dropTicket);
      throw new LockWaitTimeout(holder, now - progressStart, slotMode ? lastHolders : undefined);
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

const runsDirOf = (env) => path.join(path.dirname(lockPath(env)), "test-runs");
const RUN_ID = /^[a-z0-9-]+$/;
const trunc = (t, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** The run records in `dir` as [{...record}, ...] sorted by start; records of dead pids are removed (with their stop file) and left out. */
function liveRuns(dir) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {}
  for (const n of names) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
    } catch {
      continue;
    }
    if (!Number.isInteger(rec?.pid) || typeof rec.id !== "string") continue;
    if (!pidAlive(rec.pid)) {
      fs.rmSync(path.join(dir, n), { force: true });
      fs.rmSync(path.join(dir, `${rec.id}.stop`), { force: true });
      continue;
    }
    out.push(rec);
  }
  return out.sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
}

const runLine = (r) => `run ${r.id} (pid ${r.pid}, cwd ${r.cwd}), ${r.state}, since ${hhmm(Date.parse(r.started))}: ${r.command}`;

/** Writes the stop file of each run and waits up to STOP_WAIT_MS for their records to vanish; returns the exit code. */
async function stopRuns(dir, recs) {
  for (const r of recs) fs.writeFileSync(path.join(dir, `${r.id}.stop`), "");
  const end = Date.now() + STOP_WAIT_MS;
  let left = recs;
  while (left.length && Date.now() < end) {
    await sleep(100);
    left = left.filter((r) => fs.existsSync(path.join(dir, `${r.id}.json`)) && pidAlive(r.pid));
  }
  for (const r of recs) if (!left.includes(r)) fs.rmSync(path.join(dir, `${r.id}.stop`), { force: true });
  for (const r of recs) {
    if (left.includes(r)) process.stderr.write(`foreman_test_run: run ${r.id} (pid ${r.pid}) is still running ${STOP_WAIT_MS / 1000} s after the stop request\n`);
    else process.stdout.write(`foreman_test_run: run ${r.id} stopped\n`);
  }
  return left.length ? 1 : 0;
}

/** `--stop <id>`, `--stop-cwd` and `--list`; undefined when argv[0] is none of them. */
async function control(argv, env) {
  const dir = runsDirOf(env);
  if (argv[0] === "--list") {
    const h = readLock(lockPath(env));
    process.stdout.write(`holder: ${h ? holderText(h) : "none"}\n`);
    slotPaths(env).forEach((f, k) => {
      const sh = readLock(f);
      if (sh) process.stdout.write(`slot ${k}: ${holderText(sh)}\n`);
    });
    for (const r of liveRuns(dir)) process.stdout.write(`${runLine(r)}\n`);
    return 0;
  }
  if (argv[0] === "--stop") {
    const id = argv[1];
    if (!id || !RUN_ID.test(id)) {
      process.stderr.write("usage: foreman_test_run.mjs --stop <id>\n");
      return 1;
    }
    const rec = liveRuns(dir).find((r) => r.id === id);
    if (!rec) {
      process.stderr.write(`foreman_test_run: no running run ${id}\n`);
      return 1;
    }
    return stopRuns(dir, [rec]);
  }
  if (argv[0] === "--stop-cwd") {
    const cwd = realPath(process.cwd());
    const recs = liveRuns(dir).filter((r) => typeof r.cwd === "string" && realPath(r.cwd) === cwd);
    if (!recs.length) {
      process.stdout.write(`foreman_test_run: no runs in ${cwd}\n`);
      return 0;
    }
    return stopRuns(dir, recs);
  }
  return undefined;
}

async function main(rawArgv, env = process.env) {
  const started = Date.now();
  let argv = rawArgv;
  const controlled = await control(argv, env);
  if (controlled !== undefined) return controlled;
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
  const targeted = argv[0] === "--targeted";
  if (targeted) argv = argv.slice(1);
  if (targeted && !argv.length) {
    process.stderr.write("usage: foreman_test_run.mjs [--timeout <s>] --targeted <node args and globs/files...>\n");
    return 2;
  }
  const targetedCfg = targetedSettings({ env });
  if (argv[0] === "--exec") {
    const rest = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
    if (!rest.length) {
      process.stderr.write("usage: foreman_test_run.mjs [--timeout <s>] --exec -- <command> [args...]\n");
      return 2;
    }
    [cmd, ...args] = rest;
  } else {
    cmd = process.execPath;
    args = nodeTestArgs(argv, targeted ? targetedCfg.concurrency : testConcurrency({ env }));
  }
  const id = `${started.toString(36)}-${process.pid}`;
  const runsDir = runsDirOf(env);
  const record = {
    id,
    pid: process.pid,
    cwd: process.cwd(),
    command: trunc(argv[0] === "--exec" ? [cmd, ...args].join(" ") : ["node", ...args].join(" ")),
    started: new Date(started).toISOString(),
    mode: targeted ? "targeted" : "suite",
    state: lockDisabled(env) ? "running" : "waiting",
  };
  const recordFile = path.join(runsDir, `${id}.json`);
  const stopFile = path.join(runsDir, `${id}.stop`);
  const writeRecord = () => {
    try {
      fs.mkdirSync(runsDir, { recursive: true });
      const tmp = path.join(runsDir, `.${id}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(record));
      // On Windows the rename fails (EPERM/EBUSY) while a reader has the target open: retry, then write in place.
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(tmp, recordFile);
          break;
        } catch (e) {
          if (attempt >= 5) {
            fs.writeFileSync(recordFile, JSON.stringify(record));
            fs.rmSync(tmp, { force: true });
            break;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    } catch {}
  };
  writeRecord();
  process.on("exit", () => {
    for (const f of [recordFile, stopFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  });
  const stopRequested = () => fs.existsSync(stopFile);
  const stoppedLine = `foreman_test_run: run ${id} stopped on request\n`;
  process.stderr.write(`foreman_test_run: run ${id} (pid ${process.pid}, cwd ${process.cwd()}); stop it with: node scripts/foreman_test_run.mjs --stop ${id}\n`);
  let release = () => {};
  let holder; // the holder waited on, or the list of slot holders in targeted mode
  const maxMinutes = Number(env.FOREMAN_TEST_LOCK_MAX_MINUTES) > 0 ? Number(env.FOREMAN_TEST_LOCK_MAX_MINUTES) : 30;
  const limitLine = () =>
    `foreman_test_run: time limit of ${limitS} s reached after ${elapsedS()} s; stopped the run${holder ? `; waited for the ${targeted ? "slots held by" : "lock held by"} ${[holder].flat().map(holderText).join("; ")}` : ""}\n`;
  // a signal while waiting ends the process; the exit handlers remove the record, the stop file and the ticket
  const waitSignals = ["SIGINT", "SIGTERM"].map((s) => [s, () => process.exit(128 + os.constants.signals[s])]);
  for (const [s, h] of waitSignals) process.on(s, h);
  if (!lockDisabled(env)) {
    const waitMin = Number(env.FOREMAN_TEST_LOCK_WAIT_MINUTES) > 0 ? Number(env.FOREMAN_TEST_LOCK_WAIT_MINUTES) : 20;
    try {
      release = await acquireLock(targeted ? path.join(path.dirname(lockPath(env)), "test-slots") : lockPath(env), {
        files: targeted ? slotPaths(env, targetedCfg.slots) : undefined,
        maxWaitMs: waitMin * 60_000,
        deadlineAt: limitMs === undefined ? undefined : started + limitMs,
        onHolder: (h) => (holder = h),
        shouldStop: stopRequested,
        legacyMaxMs: maxMinutes * 60_000,
        id,
        command: record.command,
      });
    } catch (e) {
      if (e instanceof LockStopped) {
        process.stderr.write(stoppedLine);
        return 130;
      }
      if (!(e instanceof LockWaitTimeout)) throw e;
      if (limitMs !== undefined && Date.now() - started >= limitMs) {
        process.stderr.write(limitLine());
        return 124;
      }
      const heldBy = targeted ? e.holders?.map(holderText).join("; ") : e.holder && holderText(e.holder);
      process.stderr.write(`foreman_test_run: gave up waiting for the test ${targeted ? "slot" : "lock"} after ${minutes(e.waitedMs)} min; held by ${heldBy || "an unknown run"}\n`);
      return 75;
    }
  }
  for (const [s, h] of waitSignals) process.off(s, h);
  record.state = "running";
  writeRecord();
  const countDir = argv[0] === "--exec" ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "pf-spawn-count-"));
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: countDir ? nodeRunEnv(env, countDir) : withoutSessionEnv(env), shell: false });
    const forward = (sig) => () => child.kill(sig);
    const handlers = ["SIGINT", "SIGTERM"].map((s) => [s, forward(s)]);
    for (const [s, h] of handlers) process.on(s, h);
    let timer;
    let capTimer;
    let reason; // why the run is being stopped: limit, cap or stop (the first wins)
    let killing; // the kill step of a stop; the lock is released only after it
    const stopRun = (why, line) => {
      if (reason) return;
      reason = why;
      process.stderr.write(line);
      killing = killTree(child.pid);
    };
    const stopPoll = setInterval(() => {
      if (stopRequested()) stopRun("stop", stoppedLine);
    }, STOP_POLL_MS);
    const done = async (code) => {
      clearTimeout(timer);
      clearTimeout(capTimer);
      clearInterval(stopPoll);
      if (killing) await killing;
      for (const [s, h] of handlers) process.off(s, h);
      release();
      resolve(reason === "stop" ? 130 : reason ? 124 : code);
    };
    if (limitMs !== undefined) {
      timer = setTimeout(() => stopRun("limit", limitLine()), Math.max(0, limitMs - (Date.now() - started)));
    }
    if (!lockDisabled(env)) {
      capTimer = setTimeout(() => stopRun("cap", `foreman_test_run: run ${id} passed the run cap of ${maxMinutes} min; stopped the run\n`), maxMinutes * 60_000);
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
