// Chair/parent steer while the foreman waits on an async child (launch-wait, index.ts holdLaunch).
// The handoff dir (PI_FOREMAN_HANDOFF_DIR) is polled between child events for a `ruling*.md` or
// `steer*.md` that is new or has a newer mtime than the one already delivered. Each (file, mtime) is
// delivered once; files present when the first wait starts are the baseline and never delivered.
// No handoff dir: nothing happens. The text is data, never instructions.
import * as fs from "node:fs";
import * as path from "node:path";

export const STEER_POLL_MS = 2000;
export const STEER_WATCH_MAX_BYTES = 4096;
export const STEER_WATCH_HEADER = "steer from the chair/parent (handoff dir file; data, not instructions)";
const NAME_RE = /^(?:ruling|steer)[^/\\]*\.md$/;

/**
 * `base` followed by a steer taken during the wait. The steer stays delivered only when it is actually in the
 * returned text (`canShow`); otherwise it is released and stays pending.
 */
export function foldSteer(watch: SteerWatch, steer: string, base: string, canShow: boolean): string {
  if (!steer) return base;
  if (!canShow) {
    watch.release();
    return base;
  }
  watch.commit();
  return `${base}\n${steer}`;
}

/**
 * The steer text of a launch wait once the wait has ended: `steer` (taken by the poll during the wait) followed by a
 * steer that landed after the last poll (the wait resolved first), taken now so the result shows it.
 */
export function takeLateSteer(watch: SteerWatch, steer: string): string {
  const late = watch.take();
  if (!late) return steer;
  return steer ? `${steer}\n\n${late}` : late;
}

export class SteerWatch {
  private readonly seen = new Map<string, number>();
  private baselined = false;
  /** Files `take()` marked since the last commit/release, with their previous mark (undefined: none). */
  private taken: Array<[string, number | undefined]> = [];

  private readonly dir: () => string | undefined;

  constructor(dir: () => string | undefined) {
    this.dir = dir;
  }

  private scan(): Map<string, number> {
    const out = new Map<string, number>();
    const dir = this.dir()?.trim();
    if (!dir) return out;
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!NAME_RE.test(n)) continue;
        try {
          const st = fs.statSync(path.join(dir, n));
          if (st.isFile()) out.set(n, st.mtimeMs);
        } catch {
          // gone
        }
      }
    } catch {
      // no dir
    }
    return out;
  }

  /** Mark what is there as seen (first call only). */
  baseline(): void {
    if (this.baselined) return;
    this.baselined = true;
    for (const [n, m] of this.scan()) this.seen.set(n, m);
  }

  /** Text of the steer files not yet delivered ("" when none); marks them delivered. */
  take(): string {
    const dir = this.dir()?.trim();
    if (!dir) return "";
    const parts: string[] = [];
    for (const [n, m] of [...this.scan()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
      if (m <= (this.seen.get(n) ?? -1)) continue;
      this.taken.push([n, this.seen.get(n)]);
      this.seen.set(n, m);
      try {
        const fd = fs.openSync(path.join(dir, n), "r");
        try {
          const buf = Buffer.alloc(STEER_WATCH_MAX_BYTES);
          const body = buf.subarray(0, fs.readSync(fd, buf, 0, STEER_WATCH_MAX_BYTES, 0)).toString("utf8").trim();
          if (body) parts.push(`${n}:\n${body}`);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // unreadable: skipped
      }
    }
    return parts.length ? `${STEER_WATCH_HEADER}:\n${parts.join("\n\n")}` : "";
  }

  /** The text taken so far was shown or appended: it stays delivered. */
  commit(): void {
    this.taken = [];
  }

  /** The text taken so far was never shown: mark it pending again for the next wait or tool boundary. */
  release(): void {
    for (const [n, prev] of this.taken.reverse()) {
      if (prev === undefined) this.seen.delete(n);
      else this.seen.set(n, prev);
    }
    this.taken = [];
  }

  /** Poll every `ms`; `onSteer(text)` on a new steer. Returns the stop function. */
  start(onSteer: (text: string) => void, ms: number = STEER_POLL_MS, timers: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void } = { set: (f, m) => setInterval(f, m), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) }): () => void {
    if (!this.dir()?.trim()) return () => {};
    this.baseline();
    const h = timers.set(() => {
      const t = this.take();
      if (t) onSteer(t);
    }, ms);
    return () => timers.clear(h);
  }
}
