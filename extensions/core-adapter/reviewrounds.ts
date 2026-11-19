// Review rounds per change, counted from the findings store (docs/review.md#findings-store): a change is a workspace plus a branch;
// one round is one reviewer run with a primary `review` row at the gate item, pre-pr or high-stakes. Read-only.
import * as fs from "node:fs";
import * as path from "node:path";
import { findingsDirOf } from "./findings.ts";

/** A row of the findings store, as far as the rounds need it. */
export interface StoreRow {
  type?: unknown;
  session?: unknown;
  gate?: unknown;
  primary?: unknown;
  runId?: unknown;
  verdict?: unknown;
  workspace?: unknown;
  branch?: unknown;
  number?: unknown;
  ts?: unknown;
  /** Position in the store (file order, then line order): breaks a tie between equal timestamps. */
  seq: number;
}

/** Every JSON object line of every `*.jsonl` file of the store, in file-name then line order; an unreadable file or torn line is skipped. */
export function readStore(agentDir: string): StoreRow[] {
  const dir = findingsDirOf(agentDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: StoreRow[] = [];
  for (const n of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, n), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as unknown;
        if (r && typeof r === "object" && !Array.isArray(r)) out.push({ ...(r as object), seq: out.length });
      } catch {
        // a torn line
      }
    }
  }
  return out;
}

/** One change's rounds under one PR (`pr` null: no PR row joins them). */
export interface ChangeRounds {
  workspace: string;
  branch: string;
  pr: number | null;
  rounds: number;
  fail: number;
  pass: number;
  /** Rounds that held a high-stakes review, counted in `rounds` too. */
  highStakes: number;
  /** The run ids of the high-stakes rounds. */
  highStakesRuns: string[];
  /** Plan reviews (gate plan-review), counted apart by the same run rule. */
  planReviews: number;
  /** Sessions whose reviews are in the count. */
  sessions: string[];
  line: string;
}

export interface RoundsFilter {
  workspace?: string;
  branch?: string;
  pr?: number;
  /** Epoch ms: rounds started before it are left out. */
  since?: number;
}

const COUNTED = new Set(["item", "pre-pr", "high-stakes"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const timeOf = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The line of the result and of `foreman rounds`: `Review rounds: 4 (2 fail, 2 pass; 1 high-stakes), plan reviews 2, PR #301`. */
export function roundsLine(c: Pick<ChangeRounds, "rounds" | "fail" | "pass" | "highStakes" | "planReviews" | "pr">): string {
  const hs = c.highStakes > 0 ? `; ${c.highStakes} high-stakes` : "";
  return `Review rounds: ${c.rounds} (${c.fail} fail, ${c.pass} pass${hs})${c.planReviews > 0 ? `, plan reviews ${c.planReviews}` : ""}${c.pr !== null ? `, PR #${c.pr}` : ""}`;
}

interface Round {
  ws: string;
  branch: string;
  run: string;
  plan: boolean;
  fail: boolean;
  highStakes: boolean;
  ts: number;
  seq: number;
  sessions: Set<string>;
}

/**
 * Rounds per change and PR. Rows without a workspace or branch (old rows, a detached HEAD) belong to no change. A change's PR segments
 * follow the `pr` rows of the same workspace and branch (a row without a branch joins nothing) by time: a round that began before the row of
 * a later PR with another number belongs to the earlier PR. A change without rounds at the counted gates (plan reviews only) has no entry.
 */
export function roundsOf(rows: readonly StoreRow[], filter: RoundsFilter = {}): ChangeRounds[] {
  const runs = new Map<string, Round>();
  for (const r of rows) {
    if (r.type !== "review" || r.primary !== true) continue;
    const gate = str(r.gate);
    const ws = str(r.workspace);
    const branch = str(r.branch);
    const run = str(r.runId);
    if (!gate || !ws || !branch || !run) continue;
    const plan = gate === "plan-review";
    if (!plan && !COUNTED.has(gate)) continue;
    const key = `${ws}\0${branch}\0${run}\0${plan ? "p" : "r"}`;
    const ts = timeOf(r.ts);
    const have = runs.get(key) ?? { ws, branch, run, plan, fail: false, highStakes: false, ts, seq: r.seq, sessions: new Set<string>() };
    if (ts && (!have.ts || ts < have.ts)) have.ts = ts;
    if (String(r.verdict ?? "").toUpperCase() === "FAIL") have.fail = true;
    if (gate === "high-stakes") have.highStakes = true;
    const session = str(r.session);
    if (session) have.sessions.add(session);
    runs.set(key, have);
  }
  const prRows = new Map<string, { number: number; ts: number; seq: number }[]>();
  for (const r of rows) {
    const ws = str(r.workspace);
    const branch = str(r.branch);
    if (r.type !== "pr" || !ws || !branch || typeof r.number !== "number") continue;
    const k = `${ws}\0${branch}`;
    prRows.set(k, [...(prRows.get(k) ?? []), { number: r.number, ts: timeOf(r.ts), seq: r.seq }]);
  }
  // per change: the PR numbers in time order, each with the time its row first appeared
  const segments = new Map<string, { number: number; from: number }[]>();
  for (const [k, list] of prRows) {
    const seg: { number: number; from: number }[] = [];
    for (const p of [...list].sort((a, b) => a.ts - b.ts || a.seq - b.seq)) if (!seg.some((x) => x.number === p.number)) seg.push({ number: p.number, from: p.ts });
    segments.set(k, seg);
  }
  const groups = new Map<string, ChangeRounds>();
  for (const round of [...runs.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq)) {
    if (filter.workspace !== undefined && round.ws !== filter.workspace) continue;
    if (filter.branch !== undefined && round.branch !== filter.branch) continue;
    if (filter.since !== undefined && round.ts < filter.since) continue;
    const seg = segments.get(`${round.ws}\0${round.branch}`) ?? [];
    // the round belongs to the first PR whose successor (another number) was recorded after the round began
    let pr: number | null = null;
    for (let i = 0; i < seg.length; i++) {
      pr = seg[i].number;
      if (i + 1 >= seg.length || round.ts < seg[i + 1].from) break;
    }
    if (filter.pr !== undefined && pr !== filter.pr) continue;
    const gk = `${round.ws}\0${round.branch}\0${pr ?? ""}`;
    const g = groups.get(gk) ?? { workspace: round.ws, branch: round.branch, pr, rounds: 0, fail: 0, pass: 0, highStakes: 0, highStakesRuns: [], planReviews: 0, sessions: [], line: "" };
    if (round.plan) g.planReviews++;
    else {
      g.rounds++;
      if (round.fail) g.fail++;
      else g.pass++;
      if (round.highStakes) {
        g.highStakes++;
        g.highStakesRuns.push(round.run);
      }
    }
    for (const s of round.sessions) if (!g.sessions.includes(s)) g.sessions.push(s);
    groups.set(gk, g);
  }
  return [...groups.values()].filter((g) => g.rounds > 0).map((g) => ({ ...g, line: roundsLine(g) }));
}

/** Cutoff in epoch ms from `7d`, `12h`, `2w` or an ISO timestamp; null when it is none of them. */
export function parseSince(v: string, now = Date.now()): number | null {
  const m = /^(\d+)([hdw])$/.exec(v.trim());
  if (m) return now - Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * The result lines of a closed session: one per change (and PR) of each branch the session's primary reviews ran on, with the counts of the
 * whole change (every session). Nothing when the session ran no counted review or the store cannot be read.
 */
export function closeLines(agentDir: string, session: string): string[] {
  try {
    const rows = readStore(agentDir);
    const mine = new Set<string>();
    for (const r of rows) {
      const ws = str(r.workspace);
      const branch = str(r.branch);
      if (r.type === "review" && r.primary === true && r.session === session && ws && branch && COUNTED.has(String(r.gate))) mine.add(`${ws}\0${branch}`);
    }
    if (mine.size === 0) return [];
    const own = roundsOf(rows).filter((c) => mine.has(`${c.workspace}\0${c.branch}`));
    // the line names no branch; with more than one change it needs the branch to be told apart
    return own.map((c) => (own.length > 1 ? `${c.branch}: ${c.line}` : c.line));
  } catch {
    return [];
  }
}
