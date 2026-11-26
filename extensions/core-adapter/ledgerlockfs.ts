// The cross-process lock of a ledger file (D181), one implementation for every holder: `rewriteLocked` (ledgerfile.ts),
// the adapter's ledger.py runner (index.ts) and the `ledger` shims' Node helper (bin/ledger-run.mjs). core/scripts/ledger.py
// itself holds no lock (core/ stays at its pinned bytes); whoever runs it takes the lock around the whole run.
//
// The lock is the sidecar `<ledger>.lock`, taken by exclusive create (`wx`), holding "<pid> <epoch ms>". A lock older
// than LOCK_STALE_MS is a crashed holder's: the waiter re-reads it and deletes it only when the content still equals
// what it judged stale, then tries the create again. Residual races (accepted):
//  - two waiters read the same stale content, one deletes and creates, the other then deletes the new lock; it needs a
//    crashed holder and two waiters in one instant;
//  - a holder that runs longer than LOCK_STALE_MS (a hung ledger.py) loses its lock to a waiter's takeover;
//  - a writer that does not take the lock (a plain `python ledger.py`, an editor, a shim run without Node) is not excluded;
//  - the lock target a shim resolves before it takes the lock can change before the run (another session's Edit rebinds).
// The sync variant sleeps with Atomics.wait (it blocks the thread for the wait at most; a holder keeps the lock for
// milliseconds); the async one yields to the event loop. On a timeout both throw LedgerLockedError and the caller runs nothing.

import * as fs from "node:fs";

export const LOCK_STALE_MS = 10_000;
export const LOCK_WAIT_MS = 2_000;
/** Wait of a whole ledger.py run: longer than a crashed holder's lock (LOCK_STALE_MS) plus a normal run. */
export const LEDGER_RUN_WAIT_MS = LOCK_STALE_MS + 5_000;

export class LedgerLockedError extends Error {
  readonly code = "ELEDGERLOCK";
  constructor(file: string) {
    super(`ledger: ${file} is locked by another writer (${file}.lock); try again`);
  }
}

/**
 * Python source that prints the ledger file `ledger.py` would write for these arguments, by calling the vendored
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

function lockAgeMs(lock: string): { content: string; age: number } {
  const content = fs.readFileSync(lock, "utf8");
  const t = Number(content.split(/\s+/)[1]);
  return { content, age: Date.now() - (Number.isFinite(t) && t > 0 ? t : fs.statSync(lock).mtimeMs) };
}

/** One attempt: true when taken; false when a live holder has it. Takes over a stale lock. */
function tryTake(lock: string): boolean {
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        fs.closeSync(fd); // closed before any delete (Windows)
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      const first = lockAgeMs(lock);
      if (first.age > LOCK_STALE_MS && lockAgeMs(lock).content === first.content) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // vanished between the create and the read: try again
    }
    return false;
  }
}

/** Take `<file>.lock`, waiting up to `waitMs`; returns the release function. Throws LedgerLockedError on a timeout. */
export function takeLedgerLock(file: string, waitMs = LOCK_WAIT_MS): () => void {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  while (!tryTake(lock)) {
    if (Date.now() >= deadline) throw new LedgerLockedError(file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return () => fs.rmSync(lock, { force: true });
}

/** takeLedgerLock that waits without blocking the event loop. */
export async function takeLedgerLockAsync(file: string, waitMs = LOCK_WAIT_MS): Promise<() => void> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  while (!tryTake(lock)) {
    if (Date.now() >= deadline) throw new LedgerLockedError(file);
    await new Promise<void>((res) => setTimeout(res, 10));
  }
  return () => fs.rmSync(lock, { force: true });
}
