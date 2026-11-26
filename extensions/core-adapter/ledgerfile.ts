// One cross-process lock for every harness writer of a ledger file, shared with core/scripts/ledger.py (D181).
//
// The lock is the sidecar `<ledger>.lock`, taken by exclusive create (`wx`), holding "<pid> <epoch ms>". A lock older
// than LOCK_STALE_MS is a crashed holder's: the waiter re-reads it and deletes it only when the content still equals
// what it judged stale, then tries the create again. Residual race (accepted): two waiters read the same stale content,
// one deletes and creates, the other then deletes the new lock; it needs a crashed holder and two waiters in one instant.
// The writers here are synchronous (they sleep with Atomics.wait, blocking the event loop for the wait at most), because
// a holder keeps the lock for milliseconds. On a timeout the writer fails with an error and writes nothing.

import * as fs from "node:fs";
import path from "node:path";
import { fileIdOf } from "./fileid.ts";
import { renameRetry } from "./hints.ts";

export const LOCK_STALE_MS = 10_000;
export const LOCK_WAIT_MS = 2_000;

export class LedgerLockedError extends Error {
  readonly code = "ELEDGERLOCK";
  constructor(file: string) {
    super(`ledger: ${file} is locked by another writer (${file}.lock); try again`);
  }
}

function attemptsOf(err: unknown): number {
  return (err as { attempts?: number }).attempts ?? 0;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockAgeMs(lock: string): { content: string; age: number } {
  const content = fs.readFileSync(lock, "utf8");
  const t = Number(content.split(/\s+/)[1]);
  return { content, age: Date.now() - (Number.isFinite(t) && t > 0 ? t : fs.statSync(lock).mtimeMs) };
}

/** Take `<file>.lock`, waiting up to `waitMs`; returns the release function. Throws LedgerLockedError on a timeout. */
export function takeLedgerLock(file: string, waitMs = LOCK_WAIT_MS): () => void {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        fs.closeSync(fd); // closed before any delete (Windows)
      }
      return () => fs.rmSync(lock, { force: true });
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
    if (Date.now() >= deadline) throw new LedgerLockedError(file);
    sleep(10);
  }
}

export interface FileStamp {
  mtimeMs: number;
  size: number;
  fileId: string | null;
}

/** The stamp of the file as it is now, or null when it does not exist. */
export function stampOf(file: string): FileStamp | null {
  try {
    const st = fs.statSync(file, { bigint: true });
    return { mtimeMs: Number(st.mtimeNs / 1000n), size: Number(st.size), fileId: fileIdOf(st) };
  } catch {
    return null;
  }
}

export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size && a.fileId !== null && a.fileId === b.fileId;
}

/**
 * Read the file, let `step` compute the next text (null: no write), and replace the file atomically, all inside the
 * lock. When the file's stamp changed between the read and the replace (a writer outside the lock), the read and the
 * step run once more; a second change throws. Returns the step's value. Throws LedgerLockedError, a read error or the
 * rename error.
 */
export function rewriteLocked<T>(file: string, step: (text: string) => { next: string | null; value: T }, rename?: (a: string, b: string) => void): T {
  const release = takeLedgerLock(file);
  try {
    for (let attempt = 1; ; attempt++) {
      const before = stampOf(file);
      const out = step(fs.readFileSync(file, "utf8"));
      if (out.next === null) return out.value;
      if (!sameStamp(before, stampOf(file))) {
        if (attempt === 1) continue;
        throw Object.assign(new Error(`ledger: ${file} changed while it was being written; try again`), { phase: "write" });
      }
      const tmp = path.join(path.dirname(file), `.ledger-${process.pid}-${Date.now()}.tmp`);
      try {
        fs.writeFileSync(tmp, out.next, "utf8");
        try {
          fs.chmodSync(tmp, fs.statSync(file).mode & 0o7777);
        } catch {
          // keep the default mode
        }
        const rr = renameRetry(tmp, file, rename);
        if (rr.error) throw Object.assign(rr.error, { attempts: rr.attempts });
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw Object.assign(err as Error, { phase: "write", attempts: attemptsOf(err) });
      }
      return out.value;
    }
  } finally {
    release();
  }
}
