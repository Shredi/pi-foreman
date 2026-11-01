// r79 owner presence around a dialog (plan 8): refresh the presence sample first (away denies at once), then keep the dialog open without a fixed
// timeout while the owner is there; a watchdog re-probes every minute and aborts the dialog when the owner turns away. `unknown` counts as present.
// `presence.enabled: false` makes `away()` false and the watchdog is not started.

/** The slice of presence.ts `Presence` the wait uses. */
export interface PresenceLike {
  refresh(): Promise<void>;
  /** True when the cached sample says away (disabled, unknown and unsampled count as present). */
  away(): boolean;
}

export interface WaitTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: WaitTimers = {
  set: (fn, ms) => {
    const h = setInterval(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export const WATCHDOG_MS = 60_000;
export const OWNER_AWAY_REASON = "owner-away";

/** The deny text when the owner is away from the machine. */
export const OWNER_AWAY_TEXT = "pi-foreman: denied: the owner is away from the machine (no input for a while), so nobody can answer. The owner is absent; do not wait or retry, report this line and continue with what you can.";
/** The deny text for a session with no pane to ask in (headless, or a child without a parent pane). */
export const NO_PANE_TEXT = "pi-foreman: denied: nobody is at this session (no pane). The owner is absent; do not wait or retry, report this line and continue with what you can.";

export interface WaitOptions {
  /** `presence.enabled`; false skips the probe and the watchdog. Default true. */
  enabled?: boolean;
  intervalMs?: number;
  timers?: WaitTimers;
}

export type PresenceResult<T> = { away: false; value: T } | { away: true; during: boolean };

/**
 * Run `open(signal)` while the owner is present. Away before the dialog: `{away: true, during: false}` without opening it. Away while it is
 * open: the signal aborts (reason `owner-away`), `open` is expected to settle (Pi's select/confirm/input resolve undefined) and the result is
 * `{away: true, during: true}`. A call to `open` that rejects propagates.
 */
export async function withPresence<T>(presence: PresenceLike | undefined, open: (signal: AbortSignal) => Promise<T>, o: WaitOptions = {}): Promise<PresenceResult<T>> {
  const enabled = o.enabled !== false && presence !== undefined;
  if (enabled) {
    try {
      await presence.refresh();
    } catch {
      // a failed probe is unknown, which counts as present
    }
    if (presence.away()) return { away: true, during: false };
  }
  const ac = new AbortController();
  const timers = o.timers ?? realTimers;
  let handle: unknown;
  let busy = false;
  if (enabled) {
    handle = timers.set(() => {
      if (busy || ac.signal.aborted) return;
      busy = true;
      void (async () => {
        try {
          await presence.refresh();
          if (presence.away()) ac.abort(OWNER_AWAY_REASON);
        } catch {
          // unknown: still present
        } finally {
          busy = false;
        }
      })();
    }, o.intervalMs ?? WATCHDOG_MS);
  }
  try {
    const value = await open(ac.signal);
    return ac.signal.aborted ? { away: true, during: true } : { away: false, value };
  } finally {
    if (handle !== undefined) timers.clear(handle);
  }
}
