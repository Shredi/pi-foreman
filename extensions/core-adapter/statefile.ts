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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
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
