// Role ladder (frugal roles, D2 / ruling 19): two rungs per role, `model` (bottom) and `strong`.
//
// Climb triggers:
//   (a) context: a child on its bottom rung whose last call's context (input + cacheRead +
//       cacheWrite) passes strongAbove is steered once to stop and return a handoff report whose
//       first line is `RUNG_UP: context` (child side, single launches: the binding carries the limit);
//   (b) stuck: a child report with `STATUS: stuck` or "own checks failed";
//   (c) foreman: `model: "strong"` plus a `reason` on the launch.
// A run that ends on its bottom rung with (a) or (b) is climb-eligible: the foreman's launch result
// gets a hint, and the next `strong` launch of that role gets the handoff (the prior report,
// bounded, its result path and the ledger item lines) prepended to its task. A `strong` launch
// with no reason and no trigger for that role (eligible run, heavy-tier builder, strongOnRevision
// revision) is refused. The harness never relaunches by itself (design/architecture.md, ladder).
//
//   (d) turns: a child on its bottom rung past childMaxTurns assistant turns is steered once to
//       hand off (`RUNG_UP: turns`); on the top rung it is steered to stop and report (a looping
//       small model is the failure this catches).
// The bottom rung never escalates thinking (launchmodel.ts: a configured rung level wins); the
// climb is by model.
//
// strongAbove / childMaxTurns: roles.<role>.<key>, else providers.<p>.<key>, else ladder.<key>,
// else 100000 / 60.
//
//   (e) review_fail: a builder revision launched while the latest review verdict is FAIL goes to
//       the strong rung when strongOnRevision resolves true (same lookup; L1 ladder.strongOnRevision
//       true). A revision without a FAIL climbs only with providers.<p>.strongOnRevision true
//       (reason revision). The finish gate refuses once more, uncounted, while that climb is open.
//
// The live rung: `live` holds each role's model of its latest launch (single, tasks, chain,
// parallel). A climb starts from that model; when it already is the strong rung there is no
// rung_up, the trace records `rung_top {role, model, reason}` and the launch proceeds unchanged.
import { get, type Json } from "./config.ts";
import { splitLevel, type Tier } from "./launchmodel.ts";
import type { RunEnd } from "./launchwait.ts";

export const DEFAULT_STRONG_ABOVE = 100_000;
export const RUNG_UP_MARKER = "RUNG_UP:";
export const DEFAULT_CHILD_MAX_TURNS = 60;
export const HANDOFF_MAX = 4_000;
const LEDGER_LINES_MAX = 12;

export type ClimbCause = "context" | "turns" | "stuck" | "checks_failed";

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** A per-role, per-provider, ladder-wide positive integer knob (see the module comment). */
function knob(config: Json | undefined, provider: string | undefined, role: string, key: string, dflt: number): number {
  for (const v of [get(config, `roles.${role}.${key}`), provider ? get(config, `providers.${provider}.${key}`) : undefined, get(config, `ladder.${key}`)]) {
    if (posInt(v)) return v;
  }
  return dflt;
}

/** strongOnRevision of `role` on `provider`: roles.<role>, else providers.<p>, else ladder; unset = false. */
export function strongOnRevision(config: Json | undefined, provider: string | undefined, role: string): boolean {
  for (const v of [get(config, `roles.${role}.strongOnRevision`), provider ? get(config, `providers.${provider}.strongOnRevision`) : undefined, get(config, `ladder.strongOnRevision`)]) {
    if (typeof v === "boolean") return v;
  }
  return false;
}

/**
 * The climb of a builder revision launch: "review_fail" after a reviewer FAIL with strongOnRevision
 * on; "revision" without a FAIL only when providers.<p>.strongOnRevision is explicitly true; else null.
 */
export function revisionClimb(config: Json | undefined, provider: string | undefined, failed: boolean): "review_fail" | "revision" | null {
  if (!strongOnRevision(config, provider, "builder")) return null;
  if (failed) return "review_fail";
  return provider && get(config, `providers.${provider}.strongOnRevision`) === true ? "revision" : null;
}

/** The strongAbove limit of `role` on `provider`. */
export function strongAbove(config: Json | undefined, provider: string | undefined, role: string): number {
  return knob(config, provider, role, "strongAbove", DEFAULT_STRONG_ABOVE);
}

/** The childMaxTurns cap of `role` on `provider`. */
export function childMaxTurns(config: Json | undefined, provider: string | undefined, role: string): number {
  return knob(config, provider, role, "childMaxTurns", DEFAULT_CHILD_MAX_TURNS);
}

/** Context tokens of one call: input + cacheRead + cacheWrite of its usage. */
export function contextTokens(usage: unknown): number {
  if (!isObj(usage)) return 0;
  const n = (k: string): number => (typeof usage[k] === "number" && Number.isFinite(usage[k]) ? (usage[k] as number) : 0);
  return n("input") + n("cacheRead") + n("cacheWrite");
}

export interface ChildSteer {
  trigger: "context" | "turns";
  text: string;
  /** context: tokens of the call; turns: assistant turns so far. */
  count: number;
  rung: "bottom" | "top";
}

/**
 * Child side, one instance per child session: counts assistant turns and steers at most once.
 * Bottom rung: context above strongAbove or turns above childMaxTurns -> handoff report marked
 * `RUNG_UP: context|turns` (climb-eligible). Top rung (strong, or no strong mapped): turns above
 * childMaxTurns -> stop and report. No limits (no binding, tasks/chain children) = no checks.
 */
export class ChildLadder {
  private steered = false;
  private turns = 0;
  private readonly o: { strongAbove?: number; maxTurns?: number; bottom?: boolean };
  constructor(o: { strongAbove?: number; maxTurns?: number; bottom?: boolean } | undefined) {
    this.o = o ?? {};
  }

  /** One assistant message_end: the steer to send, else null. */
  onUsage(usage: unknown): ChildSteer | null {
    this.turns++;
    if (this.steered) return null;
    const rung = this.o.bottom ? "bottom" : "top";
    const tokens = contextTokens(usage);
    if (this.o.bottom && posInt(this.o.strongAbove) && tokens > this.o.strongAbove) {
      this.steered = true;
      return { trigger: "context", count: tokens, rung, text: steerText("context", `your context is ${tokens} tokens, above strongAbove ${this.o.strongAbove} for this model`) };
    }
    if (posInt(this.o.maxTurns) && this.turns > this.o.maxTurns) {
      this.steered = true;
      const why = `you have used ${this.turns} turns, above childMaxTurns ${this.o.maxTurns}`;
      return { trigger: "turns", count: this.turns, rung, text: this.o.bottom ? steerText("turns", why) : `pi-foreman ladder: ${why}. Stop now and start no new work. Reply with your report: Done, Remaining, Files touched, and what kept you looping.` };
    }
    return null;
  }
}

export function steerText(trigger: "context" | "turns", why: string): string {
  return [
    `pi-foreman ladder: ${why}. Stop now and start no new work.`,
    `Reply with a handoff report. Its first line is exactly: ${RUNG_UP_MARKER} ${trigger}`,
    "Then: Done: <what is finished>; Remaining: <what is left>; Files touched: <paths>.",
    "The foreman relaunches the task on a stronger model with your report.",
  ].join("\n");
}

/** Why a child report asks for a climb, or null. */
export function climbCause(summary: string): ClimbCause | null {
  // The run-end summary may put a "<role>:" line before the child's own first line.
  const first = summary.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).find((l) => l.startsWith(RUNG_UP_MARKER)) ?? "";
  if (first) return /turns/i.test(first) ? "turns" : /stuck/i.test(first) ? "stuck" : /check/i.test(first) ? "checks_failed" : "context";
  if (/^\s*STATUS:\s*stuck\b/im.test(summary)) return "stuck";
  if (/\bown checks failed\b/i.test(summary)) return "checks_failed";
  return null;
}

export interface Handoff {
  role: string;
  runId: string;
  cause: ClimbCause;
  summary: string;
  resultPath: string | null;
}

/** One line for the foreman's launch result when a run ended climb-eligible. */
export function climbHint(h: Handoff): string {
  return `pi-foreman ladder: run ${h.runId} (${h.role}) ended climb-eligible (${h.cause}). Relaunch it with model "strong" (a reason is optional now); the harness prepends this run's report and the ledger items to the task.`;
}

// Same line format as core/scripts/ledger.py ITEM_RE (ledgercall.ts ITEM_LINE).
const ITEM_LINE = /^\s*[-*] \[(.)\]\s+(?:deferred:.*? — )?(\d+|V)\.(?:\s+|$)/;

/** Ledger item lines the task names ("item 3", "items 1, 2 and 4", "#5"); with none named, the open items. */
export function ledgerLines(ledger: string | null, task: string): string[] {
  if (!ledger) return [];
  const items: { line: string; id: string; open: boolean }[] = [];
  let fenced = false;
  for (const line of ledger.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const m = fenced ? null : ITEM_LINE.exec(line);
    if (m) items.push({ line: line.trim(), id: m[2], open: m[1] === " " });
  }
  const named = new Set<string>();
  for (const m of task.matchAll(/\bitems?\s+((?:\d+|V)(?:\s*(?:,|and|&)\s*(?:\d+|V))*)/gi)) for (const id of m[1].split(/\s*(?:,|and|&)\s*/i)) named.add(id.toUpperCase());
  for (const m of task.matchAll(/#(\d+)\b/g)) named.add(m[1]);
  const pick = named.size ? items.filter((i) => named.has(i.id)) : items.filter((i) => i.open);
  return pick.slice(0, LEDGER_LINES_MAX).map((i) => i.line);
}

/** The block prepended to the strong launch's task. */
export function handoffBlock(h: Handoff, ledger: string[]): string {
  const s = h.summary.length > HANDOFF_MAX ? `${h.summary.slice(0, HANDOFF_MAX)}\n[... cut at ${HANDOFF_MAX} characters; the full report is under the result path]` : h.summary || "(no output)";
  return [
    `[pi-foreman rung-up handoff] The previous ${h.role} run ${h.runId} stopped (${h.cause}). Continue from its report; do not redo finished work.`,
    `Previous report:\n${s}`,
    ...(h.resultPath ? [`Full result: ${h.resultPath}`] : []),
    ...(ledger.length ? [`Ledger items:\n${ledger.join("\n")}`] : []),
    "[end of handoff]",
    "",
  ].join("\n");
}

export interface Climb {
  entry: Json;
  role: string;
  from: string;
  to: string;
  /** context | stuck | checks_failed | foreman | heavy | revision | review_fail */
  reason: string;
  handoff?: Handoff;
  /** The live model already is the strong rung: traced as rung_top, not rung_up. */
  top?: boolean;
}

export interface LadderOptions {
  tier?: Tier;
  /** strongOnRevision applies to this launch (a revision relaunch). */
  preferStrong?: boolean;
  /** The rung_up reason of a preferStrong climb (default "revision"). */
  revisionReason?: "revision" | "review_fail";
}

/** Foreman side: rung per launch, climb-eligible runs per role. */
export class LadderState {
  private readonly byCall = new Map<string, { role: string; bottom: boolean }>();
  private readonly byRun = new Map<string, { role: string; bottom: boolean }>();
  readonly eligible = new Map<string, Handoff>();
  /** Per role: the model of its latest launch (the live rung). */
  readonly live = new Map<string, string>();

  /** A launch passed every check (models written): record each entry's model as its role's live rung. */
  noteLaunched(input: Json): void {
    for (const e of launchEntries(input)) if (typeof e.agent === "string" && typeof e.model === "string" && e.model) this.live.set(e.agent, e.model);
  }

  /** tool_call of a single launch: whether it runs on the role's bottom rung. */
  onLaunch(callId: string, role: string, bottom: boolean): void {
    capPut(this.byCall, callId, { role, bottom });
  }

  /** tool_result: the run id the launch got. */
  onLaunched(callId: string, runId: string | null): void {
    const r = this.byCall.get(callId);
    this.byCall.delete(callId);
    if (r && runId) capPut(this.byRun, runId, r);
  }

  /** Run end: a bottom-rung run whose report asks for a climb becomes the role's handoff. */
  onRunEnd(end: RunEnd | null): Handoff | null {
    if (!end) return null;
    const r = this.byRun.get(end.runId);
    this.byRun.delete(end.runId);
    if (!r || !r.bottom) return null;
    const cause = climbCause(end.summary);
    if (!cause) return null;
    const h: Handoff = { role: r.role, runId: end.runId, cause, summary: end.summary, resultPath: end.resultPath };
    this.eligible.set(r.role, h);
    return h;
  }

  /**
   * Check the `strong` launches of a `subagent` call (before the models are written): a refusal,
   * or the climbs to apply once every other check passed. Reasons are read and removed here.
   */
  plan(input: Json, roles: Record<string, Json>, opts: LadderOptions = {}): { block?: string; climbs: Climb[] } {
    const climbs: Climb[] = [];
    const topReason = input.reason;
    delete input.reason;
    const entries: { e: Json; passed: unknown; reason: unknown }[] = [];
    if (Array.isArray(input.tasks) || Array.isArray(input.chain)) {
      const visit = (list: unknown): void => {
        if (!Array.isArray(list)) return;
        for (const e of list) {
          if (!isObj(e)) continue;
          const reason = e.reason ?? topReason;
          delete e.reason;
          if (typeof e.agent === "string") entries.push({ e, passed: e.model ?? input.model, reason });
          visit(e.parallel);
        }
      };
      visit(input.tasks);
      visit(input.chain);
    } else if (typeof input.agent === "string") entries.push({ e: input, passed: input.model, reason: topReason });
    for (const { e, passed, reason } of entries) {
      const role = e.agent as string;
      const r = roles[role];
      const strong = isObj(r) && isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model ? (r.strong.model as string) : null;
      if (!strong || !isObj(r) || typeof r.model !== "string") continue;
      const keyword = typeof passed === "string" ? splitLevel(passed.trim()).base : "";
      const bottom = splitLevel(r.model).base;
      const lv = this.live.get(role);
      const from = lv ? splitLevel(lv).base : bottom;
      const to = splitLevel(strong).base;
      const top = from === to || undefined;
      if (keyword !== "strong") {
        if (keyword === "" && role === "builder" && opts.preferStrong) climbs.push({ entry: e, role, from, to, reason: opts.revisionReason ?? "revision", top });
        continue;
      }
      const h = this.eligible.get(role);
      const why = h ? h.cause : typeof reason === "string" && reason.trim() ? "foreman" : role === "builder" && opts.tier === "heavy" ? "heavy" : role === "builder" && opts.preferStrong ? (opts.revisionReason ?? "revision") : null;
      if (!why) return { block: `pi-foreman: strong launch of ${role} refused [strong_no_reason]: pass a "reason" with model "strong" (why the bottom rung ${bottom} cannot do it), or launch on the default model; a climb-eligible run of ${role} (context, STATUS: stuck, own checks failed) also allows it.`, climbs: [] };
      climbs.push({ entry: e, role, from, to, reason: why, handoff: h, top });
    }
    return { climbs };
  }

  /** Apply the climbs: prepend handoffs to the task, consume them; the rung_up trace records. */
  apply(climbs: Climb[], ledgerOf: (task: string) => string[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const c of climbs) {
      if (c.handoff) {
        const task = typeof c.entry.task === "string" ? c.entry.task : "";
        c.entry.task = handoffBlock(c.handoff, ledgerOf(task)) + task;
        this.eligible.delete(c.role);
      }
      out.push(c.top ? { event: "rung_top", role: c.role, model: c.to, reason: c.reason } : { event: "rung_up", role: c.role, from: c.from, to: c.to, reason: c.reason });
    }
    return out;
  }
}

/** The launch entries of a `subagent` call: the call itself, or its tasks, chain and chain parallel entries. */
export function launchEntries(input: Json): Json[] {
  if (!Array.isArray(input.tasks) && !Array.isArray(input.chain)) return [input];
  const out: Json[] = [];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!isObj(e)) continue;
      out.push(e);
      visit(e.parallel);
    }
  };
  visit(input.tasks);
  visit(input.chain);
  return out;
}

/** Whether `role` has a strong rung in the role map. */
export function hasStrongRung(roles: Record<string, Json>, role: string): boolean {
  const r = roles[role];
  return isObj(r) && isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model !== "";
}

/** Single launches only: whether the resolved model is the role's bottom rung (it has a strong rung above). */
export function onBottomRung(roles: Record<string, Json>, role: string, model: unknown): boolean {
  const r = roles[role];
  if (!isObj(r) || typeof r.model !== "string" || typeof model !== "string") return false;
  const strong = isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model ? splitLevel(r.strong.model).base : null;
  const base = splitLevel(model).base;
  return strong !== null && base !== strong && base === splitLevel(r.model).base;
}

function capPut<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > 64) m.delete(m.keys().next().value as K);
}
