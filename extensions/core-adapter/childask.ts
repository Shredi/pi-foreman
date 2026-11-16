// A child's policy ask goes to its parent (plan Addendum 5). The parent creates an ask dir per launch under
// `<agentDir>/pi-foreman/state/child-asks/<parent>/<launch>/` and passes it in the launch binding; the child gate writes `ask.md`
// there (extension code, never a tool: floors.ts protects the tree) and waits for `ruling-<n>.md`. This module is the parent side:
// a poll over the ask dirs of one session's running children, one answer at a time, and the ruling write. Nothing here is a model.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRulingName } from "./ruling.ts";

export const CHILD_ASK_POLL_MS = 500;
const ASK_HEADER_RE = /^# Ask (\d{1,6}): (\S.*)$/;

/** `# Ask <n>: <topic>` on the first line of ask.md; null for anything else. */
export function parseAskHeader(text: string): { n: number; topic: string } | null {
  const m = ASK_HEADER_RE.exec(text.split(/\r?\n/, 1)[0].trim());
  return m ? { n: Number(m[1]), topic: m[2].trim() } : null;
}
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
  /** `danger-<name>`, `rule <text>`, `selfmod`, `no rule matches` (or an older `policy ask` / `review unreachable`). */
  cause: string;
  /** Older asks only; empty for the cause values above. */
  entry: string;
  /** The classifier's or the gate's one-line reason. */
  reason: string;
  payload: string;
  cwd: string;
  /** Epoch ms after which the child no longer waits; 0 = unknown. */
  deadline: number;
  /** Hash of the child's whole tool input, as the child wrote it; "" for an older ask. Never recomputed by the parent. */
  inputHash?: string;
}

export interface ChildAnswer {
  allow: boolean;
  reason?: string;
  /** The dialog answer (`allow-once`, `allow-remember`, `dismissed`, ...); goes to the parent's gate log, not into the ruling file. */
  how?: string;
  /** The dialog was closed by the shutdown or an abort, not by the owner: no ruling is written and the ask stays open. */
  noRuling?: true;
}

/** What a child's gate puts into `ask.md`. */
export interface ChildAskInput {
  tool: string;
  /** The full command or payload; written whole. */
  payload: string;
  cwd: string;
  session: string;
  cause: string;
  reason: string;
  entry?: string;
  role?: string;
  run?: string;
  /** Epoch ms after which the child stops waiting. */
  deadline?: number;
  /** `inputHash` of the whole tool input (`payload` is a shortened view of it). */
  inputHash?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v);

/** SHA-256 (hex) of `input` as JSON with every object's keys sorted: the same input gives the same hash whatever its key order. */
export function inputHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(input)) ?? "null").digest("hex");
}

/** The next free ask number of a handoff dir: above every `# Ask <n>` header and every `ruling-<n>.md` present. */
export function nextAskN(dir: string): number {
  let n = 0;
  try {
    n = Math.max(n, parseAskHeader(fs.readFileSync(path.join(dir, "ask.md"), "utf8"))?.n ?? 0);
  } catch {
    // no ask yet
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = isRulingName(f) ? /^ruling-(\d+)\.md$/.exec(f) : null;
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    // unreadable dir: n stays
  }
  return n + 1;
}

/** Write `<dir>/ask.md` (header `# Ask <n>: <topic>`, `key: value` lines, then the whole payload in a fence; no cut) atomically and return n. */
export function writeChildAsk(dir: string, a: ChildAskInput): number {
  const n = nextAskN(dir);
  const text = [
    `# Ask ${n}: gate ${oneLine(a.cause)} for ${a.tool}`,
    "",
    `cause: ${oneLine(a.cause)}`,
    `reason: ${oneLine(a.reason)}`,
    ...(a.entry ? [`entry: ${oneLine(a.entry)}`] : []),
    `tool: ${a.tool}`,
    `cwd: ${a.cwd}`,
    `session: ${a.session}`,
    ...(a.role ? [`role: ${a.role}`] : []),
    ...(a.run ? [`run: ${a.run}`] : []),
    ...(a.deadline ? [`deadline: ${a.deadline}`] : []),
    ...(a.inputHash ? [`input-hash: ${a.inputHash}`] : []),
    "",
    `Answer with ruling-${n}.md whose first line is ALLOW or DENY (anything else denies).`,
    "",
    "```",
    a.payload,
    "```",
    "",
  ].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.ask.md.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, path.join(dir, "ask.md"));
  return n;
}

export type RulingAnswer = { answer: "allow" | "deny" | "other" | "timeout" | "away" | "gone" | "aborted"; first?: string; reason?: string };

/** Re-check cadence of the parent-away probe and of the gone check while a child waits. */
export const AWAY_CHECK_MS = 60_000;

/** More that can end a wait: the call's abort signal, and the check whether the starting session is gone. */
export interface RulingOptions {
  signal?: AbortSignal;
  /**
   * Gone = the ask dir is missing, or the starting session's live file (`liveFile`) is missing or its heartbeat older than `staleMs` on two checks in a
   * row. A check counts only when the clock (`now`, the child's own) moved by less than two intervals since the check before; a larger jump restarts the count.
   */
  gone?: { everyMs?: number; liveFile?: string; staleMs?: number; now?: () => number };
}

function liveStale(file: string | undefined, now: number, staleMs: number): boolean {
  if (!file) return false;
  try {
    const beat = Date.parse(String((JSON.parse(fs.readFileSync(file, "utf8")) as { heartbeatAt?: unknown }).heartbeatAt));
    return !Number.isFinite(beat) || now - beat > staleMs;
  } catch {
    return true;
  }
}

/**
 * Poll `<dir>/ruling-<n>.md` until it exists or `timeoutMs` passes; its first line ALLOW / DENY (case-insensitive) decides, the rest is the reason.
 * A ruling whose mtime is before `notBefore` (ms) is stale and ignored. `away` (the presence of the parent's owner, presencewait.ts) is polled
 * every `AWAY_CHECK_MS`; when it says away the wait ends at once with `away` instead of running to the deadline. `timeoutMs` may be `Infinity`.
 * `opts`: an aborted signal ends the wait with `aborted` (no ruling is taken then); `opts.gone` ends it with `gone` (see RulingOptions).
 */
export async function awaitChildRuling(dir: string, n: number, timeoutMs: number, pollMs = 250, notBefore?: number, away?: () => boolean | Promise<boolean>, awayEveryMs = AWAY_CHECK_MS, opts: RulingOptions = {}): Promise<RulingAnswer> {
  const file = path.join(dir, `ruling-${n}.md`);
  const end = Date.now() + timeoutMs;
  let nextAway = Date.now() + awayEveryMs;
  const { signal } = opts;
  const goneClock = opts.gone?.now ?? Date.now;
  const goneEvery = opts.gone?.everyMs ?? AWAY_CHECK_MS;
  let lastGone = goneClock();
  let nextGone = lastGone + goneEvery;
  let staleChecks = 0;
  for (;;) {
    if (signal?.aborted) return { answer: "aborted" };
    try {
      const text = notBefore !== undefined && fs.statSync(file).mtimeMs < notBefore ? "" : fs.readFileSync(file, "utf8");
      const first = text.split(/\r?\n/, 1)[0].trim();
      if (first) {
        const w = first.toLowerCase();
        const reason = text.split(/\r?\n/).slice(1).join(" ").trim().slice(0, 300);
        return { answer: w === "allow" ? "allow" : w === "deny" ? "deny" : "other", first, ...(reason ? { reason } : {}) };
      }
    } catch {
      // not there yet
    }
    const left = end - Date.now();
    if (left <= 0) return { answer: "timeout" };
    if (away && Date.now() >= nextAway) {
      nextAway = Date.now() + awayEveryMs;
      try {
        if (await away()) return { answer: "away" };
      } catch {
        // unknown counts as present
      }
    }
    if (opts.gone && goneClock() >= nextGone) {
      const t = goneClock();
      const jumped = t - lastGone >= 2 * goneEvery;
      lastGone = t;
      nextGone = t + goneEvery;
      if (!fs.existsSync(dir)) return { answer: "gone" };
      if (jumped) staleChecks = 0;
      else if (liveStale(opts.gone.liveFile, t, opts.gone.staleMs ?? 0)) {
        if (++staleChecks >= 2) return { answer: "gone" };
      } else staleChecks = 0;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(h);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const h = setTimeout(done, Math.min(pollMs, left));
      signal?.addEventListener("abort", done, { once: true });
    });
  }
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
  return { dir, n: head.n, role: field("role") || "child", run: field("run"), tool: field("tool"), cause: field("cause"), entry: field("entry"), reason: field("reason"), payload: fence?.[1] ?? "", cwd: field("cwd"), deadline: Number(field("deadline")) || 0, inputHash: field("input-hash") };
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

export type ChildAskEvent = { kind: "answered" | "late" | "expired" | "failed" | "aborted"; ask: ChildAsk; allow?: boolean; detail?: string };

/**
 * The ask dirs of one session's running children. Each new ask is queued; `answer` runs for one ask at a time (one dialog at a time
 * per session). An ask whose deadline passed before its turn is dropped; an answer that comes after the deadline is reported as
 * `late` and never written.
 */
export class ChildAskWatch {
  private readonly dirs = new Map<string, number>();
  private readonly queue: ChildAsk[] = [];
  private busy = false;
  private shown: ChildAsk | null = null;
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

  /** Watch `dir`. An ask whose ruling exists is skipped; a dir that is watched already is left as it is (an ask seen once is not shown again). */
  add(dir: string): void {
    if (!this.dirs.has(dir)) {
      const a = readChildAsk(dir);
      this.dirs.set(dir, a && fs.existsSync(path.join(dir, `ruling-${a.n}.md`)) ? a.n : 0);
    }
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
    this.dirs.clear();
  }

  size(): number {
    return this.dirs.size;
  }

  /** The open ask of a watched `dir` (shown, queued, or written and not yet scanned), else null. */
  openAsk(dir: string): ChildAsk | null {
    if (this.shown?.dir === dir) return this.shown;
    const queued = this.queue.find((q) => q.dir === dir);
    if (queued) return queued;
    const last = this.dirs.get(dir);
    const a = last === undefined ? null : readChildAsk(dir);
    return a && a.n > (last ?? 0) && !fs.existsSync(path.join(dir, `ruling-${a.n}.md`)) ? a : null;
  }

  /** The watched dirs that have an open ask now. */
  openDirs(): string[] {
    return [...this.dirs.keys()].filter((d) => this.openAsk(d) !== null);
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
        this.shown = a;
        try {
          ans = await this.answer(a);
        } catch (e) {
          ans = { allow: false, reason: `the parent could not answer (${e instanceof Error ? e.message : String(e)})` };
        }
        this.shown = null;
        if (ans.noRuling) {
          this.report({ kind: "aborted", ask: a });
          continue;
        }
        if (a.deadline && this.now() > a.deadline) {
          this.report({ kind: "late", ask: a, allow: ans.allow });
          continue;
        }
        try {
          writeChildRuling(a.dir, a.n, ans);
          this.report({ kind: "answered", ask: a, allow: ans.allow, ...(ans.how ? { detail: ans.how } : {}) });
        } catch (e) {
          this.report({ kind: "failed", ask: a, detail: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
