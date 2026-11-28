// The cross-process lock of a ledger file (D181), one implementation for every holder: `rewriteLocked` (ledgerfile.ts),
// the adapter's ledger.py runner (index.ts) and the `ledger` shims' Node helper (bin/ledger-run.mjs). core/scripts/ledger.py
// itself holds no lock (core/ stays at its pinned bytes); whoever runs it takes the lock around the whole run.
//
// The lock is the sidecar `<ledger>.lock`, taken by exclusive create (`wx`), holding "<pid> <epoch ms> <nonce> <host>".
// A whole ledger.py run (python start included) takes seconds under load, so age alone never says "crashed". A waiter
// treats a lock as stale only when
//  - its holder is gone: same host (hostname and platform) and `process.kill(pid, 0)` throws ESRCH (EPERM means alive; works on Windows too), or
//  - it is older than LOCK_MAX_HOLD_MS, a hard ceiling for a holder this check cannot see (another host, a reused pid,
//    a lock without a readable pid).
// The ceiling is 120 s: one ledger.py attempt of the runner is cut at 30 s, a retry follows only a Windows access-denied
// marker (about 1 s of delays in all), so a legitimate hold stays near 35 s. Waits of whole runs (LEDGER_RUN_WAIT_MS) exceed
// the ceiling, so a waiter outlives even a lock it cannot judge. The stale lock is re-read and deleted only when it still
// equals what was judged, then the create is tried again. Residual races (accepted):
//  - pid reuse: a crashed holder's pid taken by another live process keeps its lock until the ceiling;
//  - two waiters read the same stale content, one deletes and creates, the other then deletes the new lock; it needs a
//    crashed holder and two waiters in one instant;
//  - a holder running past the ceiling (the shim helper puts no time limit on ledger.py) loses its lock to a takeover;
//  - a writer that does not take the lock (a plain `python ledger.py`, an editor, a shim run without Node) is not excluded;
//  - the lock target a shim resolves before it takes the lock can change before the run (another session's Edit rebinds).
// The sync variant sleeps with Atomics.wait (it blocks the thread, so its callers keep the short LOCK_WAIT_MS); the async
// one yields to the event loop. On a timeout both throw LedgerLockedError and the caller runs nothing.

import * as fs from "node:fs";
import * as os from "node:os";

export const LOCK_MAX_HOLD_MS = 120_000;
export const LOCK_WAIT_MS = 2_000;
/** Wait of a whole ledger.py run: longer than the ceiling, so a waiter outlives a lock it cannot judge. */
export const LEDGER_RUN_WAIT_MS = LOCK_MAX_HOLD_MS + 30_000;
/** The run wait; PI_FOREMAN_LEDGER_RUN_WAIT_MS (milliseconds) overrides it, so a test need not wait minutes. */
export function ledgerRunWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_FOREMAN_LEDGER_RUN_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : LEDGER_RUN_WAIT_MS;
}

export class LedgerLockedError extends Error {
  readonly code = "ELEDGERLOCK";
  constructor(file: string) {
    super(`ledger: ${file} is locked by another writer (${file}.lock); try again`);
  }
}

/**
 * Python source that prints the ledger file `ledger.py` would write for these arguments, by calling the
 * parser and resolver read-only (never a second resolver); prints nothing when none resolves.
 * Run as `python -I -c SNIPPET <core/scripts dir> <ledger.py args...>` with the env of the run.
 */
export const RESOLVE_SNIPPET = [
  "import sys, io, contextlib",
  "sys.path.insert(0, sys.argv[1])",
  "import ledger",
  "try:",
  "    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):",
  "        p = ledger.resolve(ledger.build_parser().parse_args(sys.argv[2:]).file)",
  "except BaseException:",
  "    sys.exit(0)",
  "print(p)",
].join("\n");

// Windows and WSL share a hostname but not pids, so the platform is part of the host: a lock of the other side is foreign.
const HOST = `${os.hostname().replace(/\s+/g, "_")}/${process.platform}`;

/** Is `pid` a running process? EPERM: it exists, another user's. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The lock's content and whether it is stale (holder gone, or past the ceiling). */
function judge(lock: string): { content: string; stale: boolean } {
  const content = fs.readFileSync(lock, "utf8");
  const [pidS, timeS, , host] = content.trim().split(/\s+/);
  const pid = Number(pidS);
  const t = Number(timeS);
  const age = Date.now() - (Number.isFinite(t) && t > 0 ? t : fs.statSync(lock).mtimeMs);
  if (age > LOCK_MAX_HOLD_MS) return { content, stale: true };
  const sameHost = host === undefined || host === HOST;
  return { content, stale: sameHost && Number.isInteger(pid) && pid > 0 && !pidAlive(pid) };
}

/** Delete `lock` only while it still holds what this holder wrote (a taken-over lock belongs to its new holder). */
function releaseOwn(lock: string, mine: string): () => void {
  return () => {
    try {
      if (fs.readFileSync(lock, "utf8") === mine) fs.rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  };
}

/** Is something (a link, even a dangling one) at `p`? A dangling link reads as ENOENT but is no vanished lock. */
function isLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** One attempt: the content this holder wrote when taken; null when a live holder has it. Takes over a stale lock. */
function tryTake(lock: string): string | null {
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      const mine = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)} ${HOST}\n`;
      try {
        fs.writeSync(fd, mine);
      } finally {
        fs.closeSync(fd); // closed before any delete (Windows)
      }
      return mine;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      const first = judge(lock);
      if (first.stale && fs.readFileSync(lock, "utf8") === first.content) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch (err) {
      // vanished between the create and the read: try again at once; any other failure (a folder, a dangling link, an
      // unreadable file at the lock path) takes the caller's sleep and deadline
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !isLink(lock)) continue;
    }
    return null;
  }
}

/** Take `<file>.lock`, waiting up to `waitMs`; returns the release function. Throws LedgerLockedError on a timeout. */
export function takeLedgerLock(file: string, waitMs = LOCK_WAIT_MS): () => void {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const mine = tryTake(lock);
    if (mine !== null) return releaseOwn(lock, mine);
    if (Date.now() >= deadline) throw new LedgerLockedError(file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

/** takeLedgerLock that waits without blocking the event loop. */
export async function takeLedgerLockAsync(file: string, waitMs = LOCK_WAIT_MS): Promise<() => void> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const mine = tryTake(lock);
    if (mine !== null) return releaseOwn(lock, mine);
    if (Date.now() >= deadline) throw new LedgerLockedError(file);
    await new Promise<void>((res) => setTimeout(res, 10));
  }
}
