// Lock and atomic-write helpers for the JSON files under <agent dir>/pi-foreman/state/ that more than one process writes
// (open-prs.json, tracked-prs*.json): a lock file with a unique token and a stale timeout, and tmp-then-rename writes.
import fs from "node:fs";
import path from "node:path";

const RENAME_RETRIES = 5;
const RENAME_WAIT_MS = 50;
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Writes `doc` as JSON to `file`: a tmp file, then a rename (retried 5 times, 50 ms apart, on EPERM, EBUSY or EACCES). Throws on failure. */
export function writeAtomic(file: string, doc: unknown): void {
  writeTextAtomic(file, JSON.stringify(doc));
}

/** Writes `text` to `file` the same way (temporary file in the same directory, then rename); the old file stays when the write or the rename fails. */
export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (i >= RENAME_RETRIES || !RETRY_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) throw err;
        sleepSync(RENAME_WAIT_MS);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}

/** The lock file holds a unique token; the token is returned, or null when another process holds a lock younger than `staleMs`. */
export function takeLock(lock: string, now: number, staleMs: number): string | null {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, token, { flag: "wx" });
      return token;
    } catch {
      try {
        if (now - fs.statSync(lock).mtimeMs <= staleMs) return null;
        fs.unlinkSync(lock);
      } catch {
        // gone meanwhile: try once more
      }
    }
  }
  return null;
}

/** True while the lock file still holds this token (a stale takeover may have replaced it). */
export function ownsLock(lock: string, token: string): boolean {
  try {
    return fs.readFileSync(lock, "utf8") === token;
  } catch {
    return false;
  }
}

/** Deletes the lock only when it still holds this token. */
export function dropLock(lock: string, token: string): void {
  try {
    if (ownsLock(lock, token)) fs.unlinkSync(lock);
  } catch { /* already gone */ }
}

export const LOCK_WAIT_MS = 5000;
export const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;

/**
 * Runs `fn` while holding `lockPath` (the lock file of the Python stores: `<file>.lock`, exclusive create, so a Python writer and this one exclude each other).
 * Waits up to `waitMs` (5 s), breaks a lock older than `staleMs` (60 s), releases on a thrown error. Throws when the lock stays held.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS): T {
  const start = Date.now();
  let token = takeLock(lockPath, Date.now(), staleMs);
  while (token === null) {
    if (Date.now() - start >= waitMs) throw new Error(`locked: ${path.basename(lockPath)}`);
    sleepSync(LOCK_POLL_MS);
    token = takeLock(lockPath, Date.now(), staleMs);
  }
  try {
    return fn();
  } finally {
    dropLock(lockPath, token);
  }
}
