// Serializes the adapter's writes to one ledger file with ledger.py work in flight.
//
// ledger.py reads the file at start and replaces it at the end; an adapter hint written between
// those two steps (a sync read-modify-write) is lost, or overwrites the child's mark. So:
//   - hold(key): a foreman bash call that runs `ledger` (held from tool_call to tool_execution_end);
//     holds are taken at once and never wait; only exclusive work waits for them.
//   - exclusive(fn): a ledger.py runner run or the upsert rewrite; waits until no hold or other
//     exclusive work is active.
//   - defer(fn): a sync hint write; runs at once when idle, else after the lock frees (fn re-reads the file).
// The gate is per process: a reviewer child's ledger.py in its own process is not serialized with the foreman's hint writes.
// A hold releases itself after `holdTimeoutMs`, so a lost tool_execution_end never leaks the lock.

import path from "node:path";

export const HOLD_TIMEOUT_MS = 30_000;

interface Waiter {
  ready: () => boolean;
  go: () => void;
}

export class LedgerGate {
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();
  private active = false;
  private readonly pending: (() => void)[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly holdTimeoutMs: number;

  constructor(holdTimeoutMs = HOLD_TIMEOUT_MS) {
    this.holdTimeoutMs = holdTimeoutMs;
  }

  private busy(): boolean {
    return this.active || this.holds.size > 0;
  }

  private pump(): void {
    if (!this.busy()) {
      const fns = this.pending.splice(0);
      for (const fn of fns) {
        try {
          fn();
        } catch {
          // a hint write is best effort
        }
      }
    }
    for (let i = 0; i < this.waiters.length; ) {
      if (this.waiters[i].ready()) {
        const [w] = this.waiters.splice(i, 1);
        w.go();
      } else i++;
    }
  }

  /** Take a hold under `key` at once (never waits, so a tool_call handler cannot stall); released by release(key) or the timeout. */
  hold(key: string): void {
    const t = setTimeout(() => this.release(key), this.holdTimeoutMs);
    t.unref?.();
    const old = this.holds.get(key);
    if (old) clearTimeout(old);
    this.holds.set(key, t);
  }

  release(key: string): void {
    const t = this.holds.get(key);
    if (t === undefined) return;
    clearTimeout(t);
    this.holds.delete(key);
    this.pump();
  }

  /** Run `fn` with no hold and no other exclusive work in flight. */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({
        ready: () => !this.busy(),
        go: () => {
          this.active = true;
          const done = (): void => {
            this.active = false;
            this.pump();
          };
          // The lock frees (and deferred hints land) before the caller sees the result.
          Promise.resolve()
            .then(fn)
            .then(
              (v) => (done(), resolve(v)),
              (e) => (done(), reject(e)),
            );
        },
      });
      this.pump();
    });
  }

  /** Run a sync write now when idle, else once the lock frees. Never dropped. */
  defer(fn: () => void): void {
    if (!this.busy() && this.waiters.length === 0) {
      fn();
      return;
    }
    this.pending.push(fn);
  }
}

const gates = new Map<string, LedgerGate>();

/** The gate of one ledger file (process-wide, keyed by the resolved path). */
export function ledgerGate(file: string): LedgerGate {
  const key = path.resolve(file);
  let g = gates.get(key);
  if (!g) gates.set(key, (g = new LedgerGate()));
  return g;
}
