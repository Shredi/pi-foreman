// Writers of a ledger file that hold the cross-process `<ledger>.lock` (D181; the lock itself is in ledgerlockfs.ts,
// shared with the ledger shims' Node helper). The writers here are synchronous (they sleep with Atomics.wait, blocking
// the event loop for the wait at most), because a holder keeps the lock for milliseconds. On a timeout the writer fails
// with an error and writes nothing.

import * as fs from "node:fs";
import path from "node:path";
import { fileIdOf } from "./fileid.ts";
import { renameRetry } from "./hints.ts";
import { takeLedgerLock } from "./ledgerlockfs.ts";

export { LedgerLockedError, LOCK_STALE_MS, LOCK_WAIT_MS, takeLedgerLock } from "./ledgerlockfs.ts";

function attemptsOf(err: unknown): number {
  return (err as { attempts?: number }).attempts ?? 0;
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
