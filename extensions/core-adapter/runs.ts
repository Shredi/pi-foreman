// Run view of the foreman's subagent launches: in-memory run state plus the usage log (read incrementally).
// It feeds the live-state file (livestate.ts), the radar runs and the `role_result` trace cost and duration.
import fs from "node:fs";
import { parseLines } from "./usage.ts";
import { priceRecord } from "./cost.ts";
import type { PriceTable } from "./cost.ts";

export type RunState = "working" | "ask" | "done";
export type Rung = "model" | "strong" | null;

export interface RunView {
  launchId: string;
  role: string;
  rung: Rung;
  /** The launch's explicit `model` (as given, e.g. `provider/id`); null when the role's own model runs. */
  model: string | null;
  state: RunState;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  startedAt: number;
  endedAt: number | null;
}

/** Rung of a single launch: bottom = the role's own model with a strong rung above it. */
export function rungOf(roles: Record<string, unknown> | undefined, role: string, bottom: boolean): Rung {
  if (bottom) return "model";
  const r = roles?.[role];
  const strong = r && typeof r === "object" ? (r as { strong?: { model?: unknown } }).strong : undefined;
  return strong && typeof strong.model === "string" && strong.model ? "strong" : null;
}

export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ------------------------------------------------------------------ usage per launch id

interface Sum {
  input: number;
  output: number;
  cost: number;
}

/** Reads the usage file of this foreman session incrementally and sums tokens and cost per launch id. */
export class UsageTail {
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  readonly by = new Map<string, Sum>();

  private readonly file: string;
  private readonly prices: PriceTable | null;
  /** `prices`: a record without a reported cost is priced from it (cost.ts). */
  constructor(file: string, prices: PriceTable | null = null) {
    this.file = file;
    this.prices = prices;
  }

  refresh(): void {
    try {
      const size = fs.statSync(this.file).size;
      if (size < this.offset) {
        this.offset = 0;
        this.rest = Buffer.alloc(0);
        this.by.clear();
      }
      if (size === this.offset) return;
      const fd = fs.openSync(this.file, "r");
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(size - this.offset);
        const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
        chunk = chunk.subarray(0, n);
        this.offset += n;
      } finally {
        fs.closeSync(fd);
      }
      const all = Buffer.concat([this.rest, chunk]);
      const cut = all.lastIndexOf(10);
      this.rest = cut < 0 ? all : all.subarray(cut + 1);
      if (cut < 0) return;
      for (const l of parseLines(all.subarray(0, cut).toString("utf8"))) {
        if (!l.launchId) continue;
        const s = this.by.get(l.launchId) ?? { input: 0, output: 0, cost: 0 };
        s.input += (l.input || 0) + (l.cacheRead || 0) + (l.cacheWrite || 0);
        s.output += l.output || 0;
        s.cost += priceRecord(l, this.prices).cost.total;
        this.by.set(l.launchId, s);
      }
    } catch {
      // no file yet, or unreadable: totals stay as they are
    }
  }
}

// ------------------------------------------------------------------ run tracking

interface Row {
  runId: string;
  launchId: string | null;
  roles: string[];
  rung: Rung;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
}

export class ChildRuns {
  private pending = new Map<string, { launchId: string | null; role: string; rung: Rung; model?: string | null }>();
  private rows = new Map<string, Row>();
  private ended = new Map<string, number>();

  private readonly tail: UsageTail | null;
  constructor(tail: UsageTail | null = null) {
    this.tail = tail;
  }

  /** tool_call of a subagent launch (single launches carry a usage launch id). */
  onLaunchCall(callId: string, p: { launchId: string | null; role: string; rung: Rung; model?: string | null }): void {
    this.pending.set(callId, p);
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** tool_result of a launch that got a run id. */
  onLaunched(callId: string, runId: string, roles: readonly string[], now = Date.now()): void {
    const p = this.pending.get(callId);
    this.pending.delete(callId);
    const list = p?.role ? [p.role] : [...roles];
    this.rows.set(runId, { runId, launchId: p?.launchId ?? null, roles: list, rung: p?.rung ?? null, model: p?.model ?? null, startedAt: now, endedAt: this.ended.get(runId) ?? null });
    if (this.rows.size > 64) this.rows.delete(this.rows.keys().next().value as string);
  }

  onRunEnd(runId: string, now = Date.now()): void {
    const r = this.rows.get(runId);
    if (r) r.endedAt = now;
    else {
      // A foreground run ends before its tool_result names it.
      this.ended.set(runId, now);
      if (this.ended.size > 64) this.ended.delete(this.ended.keys().next().value as string);
    }
  }

  /** Duration (once ended) and priced cost of one run, by run id; null for an unknown run. */
  info(runId: string): { ms: number | null; cost: number } | null {
    const r = this.rows.get(runId);
    if (!r) return null;
    this.tail?.refresh();
    const u = r.launchId ? this.tail?.by.get(r.launchId) : undefined;
    return { ms: r.endedAt !== null ? r.endedAt - r.startedAt : null, cost: u?.cost ?? 0 };
  }

  views(): RunView[] {
    this.tail?.refresh();
    const out: RunView[] = [];
    for (const r of [...this.rows.values()].sort((a, b) => a.startedAt - b.startedAt)) {
      const state: RunState = r.endedAt !== null ? "done" : "working";
      const u = r.launchId ? this.tail?.by.get(r.launchId) : undefined;
      out.push({ launchId: r.launchId ?? r.runId, role: r.roles.join("+") || "child", rung: r.rung, model: r.model, state, tokensIn: u?.input ?? 0, tokensOut: u?.output ?? 0, cost: u?.cost ?? 0, startedAt: r.startedAt, endedAt: r.endedAt });
    }
    return out;
  }
}
