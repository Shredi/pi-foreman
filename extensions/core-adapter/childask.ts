// A child's policy ask goes to its parent (plan Addendum 5). The parent creates an ask dir per launch under
// `<agentDir>/pi-foreman/state/child-asks/<parent>/<launch>/` and passes it in the launch binding; the child gate writes `ask.md`
// there (extension code, never a tool: floors.ts protects the tree) and waits for `ruling-<n>.md`. This module is the parent side:
// a poll over the ask dirs of one session's running children, one answer at a time, and the ruling write. Nothing here is a model.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAskHeader } from "./askcontract.ts";

export const CHILD_ASK_POLL_MS = 500;
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";

export const childAsksRoot = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "child-asks");
export const childAskDir = (agentDir: string, parent: string, launch: string): string => path.join(childAsksRoot(agentDir), safe(parent), safe(launch));
export const childAskParentDir = (agentDir: string, parent: string): string => path.join(childAsksRoot(agentDir), safe(parent));

export interface ChildAsk {
  dir: string;
  n: number;
  role: string;
  run: string;
  tool: string;
  cause: string;
  entry: string;
  reason: string;
  payload: string;
  cwd: string;
  /** Epoch ms after which the child no longer waits; 0 = unknown. */
  deadline: number;
}

export interface ChildAnswer {
  allow: boolean;
  reason?: string;
}

/** The ask in `<dir>/ask.md`, or null when it is absent or not an ask. */
export function readChildAsk(dir: string): ChildAsk | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "ask.md"), "utf8");
  } catch {
    return null;
  }
  const head = parseAskHeader(text);
  if (!head) return null;
  const field = (k: string): string => new RegExp(`^${k}: (.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const fence = /```\n([\s\S]*?)\n```\s*$/.exec(text);
  return { dir, n: head.n, role: field("role") || "child", run: field("run"), tool: field("tool"), cause: field("cause"), entry: field("entry"), reason: field("reason"), payload: fence?.[1] ?? "", cwd: field("cwd"), deadline: Number(field("deadline")) || 0 };
}

/** Write `<dir>/ruling-<n>.md` (first line ALLOW / DENY, then the reason), atomically: the adapter alone writes rulings there. */
export function writeChildRuling(dir: string, n: number, a: ChildAnswer): void {
  const tmp = path.join(dir, `.ruling-${n}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${a.allow ? "ALLOW" : "DENY"}\n${a.allow ? "" : (a.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) + "\n"}`, "utf8");
  fs.renameSync(tmp, path.join(dir, `ruling-${n}.md`));
}

export interface AskTimers {
  set: (f: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
}
const REAL_TIMERS: AskTimers = {
  set: (f, ms) => {
    const h = setInterval(f, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type ChildAskEvent = { kind: "answered" | "late" | "expired" | "failed"; ask: ChildAsk; allow?: boolean; detail?: string };

/**
 * The ask dirs of one session's running children. Each new ask is queued; `answer` runs for one ask at a time (one dialog at a time
 * per session). An ask whose deadline passed before its turn is dropped; an answer that comes after the deadline is reported as
 * `late` and never written.
 */
export class ChildAskWatch {
  private readonly dirs = new Map<string, number>();
  private readonly queue: ChildAsk[] = [];
  private busy = false;
  private handle: unknown;
  private readonly answer: (a: ChildAsk) => Promise<ChildAnswer>;
  private readonly report: (e: ChildAskEvent) => void;
  private readonly timers: AskTimers;
  private readonly now: () => number;

  constructor(answer: (a: ChildAsk) => Promise<ChildAnswer>, report: (e: ChildAskEvent) => void, timers: AskTimers = REAL_TIMERS, now: () => number = Date.now) {
    this.answer = answer;
    this.report = report;
    this.timers = timers;
    this.now = now;
  }

  add(dir: string): void {
    this.dirs.set(dir, 0);
    if (this.handle === undefined) this.handle = this.timers.set(() => this.poll(), CHILD_ASK_POLL_MS);
  }

  remove(dir: string): void {
    this.dirs.delete(dir);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].dir === dir) this.queue.splice(i, 1);
    if (this.dirs.size === 0) this.stop();
  }

  stop(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
    this.queue.length = 0;
  }

  size(): number {
    return this.dirs.size;
  }

  /** One scan of the ask dirs; a new `ask.md` (n above the last one seen in that dir) is queued. */
  poll(): void {
    for (const [dir, last] of this.dirs) {
      const a = readChildAsk(dir);
      if (!a || a.n <= last) continue;
      this.dirs.set(dir, a.n);
      this.queue.push(a);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let a = this.queue.shift(); a; a = this.queue.shift()) {
        if (a.deadline && this.now() > a.deadline) {
          this.report({ kind: "expired", ask: a });
          continue;
        }
        let ans: ChildAnswer;
        try {
          ans = await this.answer(a);
        } catch (e) {
          ans = { allow: false, reason: `the parent could not answer (${e instanceof Error ? e.message : String(e)})` };
        }
        if (a.deadline && this.now() > a.deadline) {
          this.report({ kind: "late", ask: a, allow: ans.allow });
          continue;
        }
        try {
          writeChildRuling(a.dir, a.n, ans);
          this.report({ kind: "answered", ask: a, allow: ans.allow });
        } catch (e) {
          this.report({ kind: "failed", ask: a, detail: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
