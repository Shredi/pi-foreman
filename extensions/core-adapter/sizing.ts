// Launch sizing (R39): a builder launch declares `size: {files, largestFileLines?, modules?}` and `risk: [...]`;
// the adapter strips both fields from every launch, measures the named files itself and picks the rung
// from the rule table (docs/ladder.md). Sizing only raises the rung: an explicit lower `model` needs a `reason`.
// Rungs only, never model names. Without `ladder.sizing` in the config the L1 values below apply.
import * as fs from "node:fs";
import * as path from "node:path";
import { get, type Json } from "./config.ts";
import { locateRepo } from "./gitdrift.ts";
import { splitLevel } from "./launchmodel.ts";
import { hasStrongRung, ranksAbove, launchEntries } from "./ladder.ts";
import { workspaceOf } from "./python.ts";
import { nextRankAboveStrong, cappedRung } from "./reviewerclimb.ts";
import type { Rank } from "./ranks.ts";

export const RISKS = ["guard", "permission", "parser", "concurrency", "security", "design"] as const;
export type Risk = (typeof RISKS)[number];
export type Rung = "default" | "strong" | "top";
const ORDER: readonly Rung[] = ["default", "strong", "top"];
export const rungIndex = (r: Rung): number => ORDER.indexOf(r);

/** At most this many files are read; each file beyond it counts as large. */
export const MAX_FILES = 20;
/** A file over this many bytes is not read and counts as large. */
export const MAX_BYTES = 1 << 20;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export interface SizingConfig {
  enabled: boolean;
  largeFileLines: number;
  maxModules: number;
  strongRisks: string[];
  topRisks: string[];
  topRung: string | null;
}

/** `ladder.sizing` of the merged config with the L1 values as fallbacks. */
export function sizingConfig(config: Json | undefined): SizingConfig {
  const posInt = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);
  const tags = (v: unknown, d: string[]): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : d);
  const top = get(config, "ladder.sizing.topRung");
  return {
    enabled: get(config, "ladder.sizing.enabled") !== false,
    largeFileLines: posInt(get(config, "ladder.sizing.largeFileLines"), 1500),
    maxModules: posInt(get(config, "ladder.sizing.maxModules"), 2),
    strongRisks: tags(get(config, "ladder.sizing.strongRisks"), ["guard", "permission", "parser", "concurrency", "security"]),
    topRisks: tags(get(config, "ladder.sizing.topRisks"), ["design"]),
    topRung: typeof top === "string" && top.trim() ? top.trim() : null,
  };
}

export interface Declared {
  size: { files: string[]; largestFileLines?: number; modules?: number } | null;
  risk: Risk[] | null;
}

export const FIX = "Fix: size: {files: [\"path\", ...], largestFileLines?: n, modules?: n} and risk: [guard|permission|parser|concurrency|security|design] (a subset).";
const invalid = (why: string): string => `pi-foreman: launch refused [sizing_invalid]: ${why}. ${FIX}`;

function count(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseOne(size: unknown, risk: unknown): { declared: Declared; error?: string } {
  const declared: Declared = { size: null, risk: null };
  if (size !== undefined) {
    if (!isObj(size)) return { declared, error: "size is not an object" };
    if (!Array.isArray(size.files) || !size.files.every((f) => typeof f === "string" && f !== "")) return { declared, error: "size.files is not an array of file names" };
    if (size.largestFileLines !== undefined && !count(size.largestFileLines)) return { declared, error: "size.largestFileLines is not a non-negative integer" };
    if (size.modules !== undefined && !count(size.modules)) return { declared, error: "size.modules is not a non-negative integer" };
    declared.size = { files: size.files as string[], ...(size.largestFileLines !== undefined ? { largestFileLines: size.largestFileLines as number } : {}), ...(size.modules !== undefined ? { modules: size.modules as number } : {}) };
  }
  if (risk !== undefined) {
    if (!Array.isArray(risk)) return { declared, error: "risk is not an array" };
    const bad = risk.find((r) => typeof r !== "string" || !(RISKS as readonly string[]).includes(r));
    if (bad !== undefined) return { declared, error: `unknown risk tag ${JSON.stringify(bad)}` };
    declared.risk = risk as Risk[];
  }
  return { declared };
}

/** The sentence the model sees (tool description, error hint): where `size` and `risk` go. */
export const TOP_LEVEL_NOTE = "`size: {files, largestFileLines?, modules?}` and `risk: [...]` are top-level keys of this call, beside `agent` and `task`, never inside `options` or `args`.";

/** The foreman's `subagent` tool description with the placement sentence added; null when sizing is off, the tool is not declared or the sentence is already there. */
export function subagentDescription(declared: readonly { name: string; description?: string }[], enabled: boolean): string | null {
  if (!enabled) return null;
  const sub = declared.find((t) => t.name === "subagent");
  if (!sub || typeof sub.description !== "string" || sub.description.includes(TOP_LEVEL_NOTE)) return null;
  return `${sub.description}\n\nBuilder launches (pi-foreman): ${TOP_LEVEL_NOTE}`;
}

/** The text appended to a pi-subagents refusal caused by a misplaced `size`/`risk`; null for any other error text. */
export function misplacedHint(errorText: string): string | null {
  if (!/unknown options key '(?:size|risk)'|args requires workflow/.test(errorText)) return null;
  return `pi-foreman: size and risk are top-level keys of the subagent call, not options or args. ${FIX}`;
}

/**
 * Move a misplaced `size`/`risk` (a launch's `options`, or its `args` when the launch names no `workflow`) to the launch's top level;
 * a value already at the top level wins and the misplaced one is dropped. Covers the call and every tasks/chain/parallel entry.
 * `from` lists where values were found and moved; `left` is true when one stays where pi-subagents reads it (args with a workflow).
 */
export function liftSizing(input: Json): { from: ("options" | "args")[]; left: boolean } {
  const from: ("options" | "args")[] = [];
  let left = false;
  for (const e of launchEntries(input)) {
    for (const key of ["options", "args"] as const) {
      const box = e[key];
      if (!isObj(box)) continue;
      if (key === "args" && e.workflow !== undefined) {
        if (box.size !== undefined || box.risk !== undefined) left = true;
        continue;
      }
      let moved = false;
      for (const f of ["size", "risk"] as const) {
        if (box[f] === undefined) continue;
        if (e[f] === undefined) e[f] = box[f];
        delete box[f];
        moved = true;
        if (!from.includes(key)) from.push(key);
      }
      // pi-subagents refuses any `args` without a `workflow` ("args requires workflow"), so an emptied box goes too
      if (moved && Object.keys(box).length === 0) delete e[key];
    }
  }
  return { from, left };
}

/**
 * Remove `size` and `risk` from a `subagent` call (top level and every tasks/chain/parallel entry) and return what each launch
 * entry declared (the entry's own value wins over the call's). `error` is the first malformed value as a refusal text; the caller
 * refuses only the foreman's own launches, elsewhere the fields are just gone.
 */
export function takeSizing(input: Json): { entries: Map<Json, Declared>; carried: Set<Json>; error?: string } {
  const entries = new Map<Json, Declared>();
  const carried = new Set<Json>();
  let error: string | undefined;
  const note = (e?: string): void => {
    if (e && !error) error = invalid(e);
  };
  const top = parseOne(input.size, input.risk);
  note(top.error);
  const list = launchEntries(input);
  for (const e of list) {
    const own = e === input ? top : parseOne(e.size, e.risk);
    if (e !== input) note(own.error);
    const eff: Declared = { size: own.declared.size ?? top.declared.size, risk: own.declared.risk ?? top.declared.risk };
    if (typeof e.agent === "string") {
      entries.set(e, eff);
      if (eff.size || eff.risk) carried.add(e);
    }
  }
  for (const e of list) {
    delete e.size;
    delete e.risk;
  }
  delete input.size;
  delete input.risk;
  return { entries, carried, ...(error ? { error } : {}) };
}

export interface LaunchFlags {
  reads?: number;
  install?: boolean;
}

const READS_ROLES: readonly string[] = ["builder", "reviewer"];
const INSTALL_ROLES: readonly string[] = ["builder", "finalizer"];

/**
 * Remove the launch fields `reads` (a positive int: the child's read allowance) and `install` (true: the child may run `npm ci`/`npm install`
 * in its owned dirs) from a `subagent` call and return what each launch entry declared (the entry's own value wins). The binding that carries
 * them exists for single launches only (`group`): a group keeps the config defaults and `notes` says so. `error` is a refusal text for a
 * malformed value; the caller refuses only the foreman's own launches.
 */
export function takeLaunchFlags(input: Json): { entries: Map<Json, LaunchFlags>; notes: string[]; group: boolean; error?: string } {
  const entries = new Map<Json, LaunchFlags>();
  const notes: string[] = [];
  let error: string | undefined;
  const bad = (what: string): void => {
    error ??= `pi-foreman: launch refused [launch_flag_invalid]: ${what}. Fix: reads: <positive integer> (builder, reviewer), install: true (builder, finalizer).`;
  };
  const group = Array.isArray(input.tasks) || Array.isArray(input.chain);
  const list = launchEntries(input);
  const own = (e: Json): { reads?: number; install?: boolean } => {
    const out: { reads?: number; install?: boolean } = {};
    if (e.reads !== undefined) {
      if (typeof e.reads === "number" && Number.isInteger(e.reads) && e.reads >= 1) out.reads = e.reads;
      else bad("reads is not a positive integer");
    }
    if (e.install !== undefined) {
      if (typeof e.install === "boolean") out.install = e.install;
      else bad("install is not true or false");
    }
    return out;
  };
  const top = group ? {} : own(input);
  let dropped = false;
  for (const e of list) {
    const mine = e === input ? top : own(e);
    const eff = { ...(group ? {} : top), ...mine };
    if (group) dropped ||= eff.reads !== undefined || eff.install !== undefined;
    if (typeof e.agent !== "string" || group) continue;
    const role = e.agent;
    const flags: LaunchFlags = {};
    if (eff.reads !== undefined) {
      if (READS_ROLES.includes(role)) flags.reads = eff.reads;
      else notes.push(`pi-foreman: launch field reads is for builder and reviewer launches; ignored for ${role}.`);
    }
    if (eff.install === true) {
      if (INSTALL_ROLES.includes(role)) flags.install = true;
      else notes.push(`pi-foreman: launch field install is for builder and finalizer launches; ignored for ${role}.`);
    }
    entries.set(e, flags);
  }
  if (group) {
    // top-level fields of a group call apply to no entry
    dropped ||= input.reads !== undefined || input.install !== undefined;
    if (dropped) notes.push("pi-foreman: reads and install are carried in the launch binding, which a group launch does not get; this group launch keeps the config read limits and its children's npm install asks. Launch the role as a single subagent({agent, task, ...}) call to set them.");
  }
  for (const e of list) {
    delete e.reads;
    delete e.install;
  }
  delete input.reads;
  delete input.install;
  return { entries, notes, group, ...(error ? { error } : {}) };
}

export interface Measured {
  files: number;
  lines: number;
  declaredLines: number;
  modules: number;
  declaredModules: number;
  /** Some named file is over the byte cap, unreadable or beyond MAX_FILES. */
  large: boolean;
  /** Files outside the workspace (not read, counted as 0 lines). */
  outside: number;
  /** A refusal text: a named path is a directory. */
  invalid?: string;
}

function realOfDeepest(p: string): string {
  let cur = path.resolve(p);
  for (;;) {
    try {
      const rest = path.relative(cur, path.resolve(p));
      return rest ? path.join(fs.realpathSync(cur), rest) : fs.realpathSync(cur);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      cur = up;
    }
  }
}

const insideRoot = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The workspace root of an entry: its own worktree when it shares the session repo's git common dir, else the session root. */
export function rootFor(entryCwd: string, sessionCwd: string): string {
  const own = workspaceOf(entryCwd).root;
  const session = workspaceOf(sessionCwd).root;
  if (own === session) return session;
  const a = locateRepo(entryCwd)?.commonDir;
  const b = locateRepo(sessionCwd)?.commonDir;
  return a && b && realOfDeepest(a) === realOfDeepest(b) ? own : session;
}

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__"]);

/** The component of a root-relative file for the module count, or null for a file that does not count (root files, docs, *.md, test dirs). */
export function componentOf(rel: string): string | null {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return null;
  if (segs[0] === "docs" || rel.endsWith(".md")) return null;
  const dirs = segs.slice(0, -1);
  if (dirs.some((s) => TEST_SEGMENTS.has(s))) return null;
  return dirs.slice(0, 2).join("/");
}

/** Measure the named files (see the module comment; the claim only raises: the larger of declared and measured). */
export function measure(d: Declared["size"], entryCwd: string, sessionCwd: string): Measured {
  const out: Measured = { files: 0, lines: 0, declaredLines: d?.largestFileLines ?? 0, modules: 0, declaredModules: d?.modules ?? 0, large: false, outside: 0 };
  if (!d) return out;
  const root = realOfDeepest(rootFor(entryCwd, sessionCwd));
  const parts = new Set<string>();
  out.files = d.files.length;
  let measuredLines = 0;
  d.files.forEach((f, i) => {
    const abs = path.resolve(entryCwd, f);
    const real = realOfDeepest(abs);
    if (!insideRoot(root, real)) {
      out.outside++;
      return;
    }
    const comp = componentOf(path.relative(root, real));
    if (comp) parts.add(comp);
    if (i >= MAX_FILES) {
      out.large = true;
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") out.large = true;
      return;
    }
    if (!st.isFile()) {
      out.invalid ??= invalid(`${f} is not a regular file (name files, not directories)`);
      return;
    }
    if (st.size > MAX_BYTES) {
      out.large = true;
      return;
    }
    try {
      const buf = fs.readFileSync(abs);
      let n = 0;
      for (const b of buf) if (b === 10) n++;
      measuredLines = Math.max(measuredLines, n);
    } catch {
      out.large = true;
    }
  });
  out.lines = Math.max(measuredLines, out.declaredLines);
  out.modules = Math.max(parts.size, out.declaredModules);
  return out;
}

export interface Decision {
  rule: string;
  rung: Rung;
}

/** The sizing rung from the first matching row of the rule table. */
export function decide(m: Measured, risk: readonly string[], cfg: SizingConfig): Decision {
  if (risk.some((r) => cfg.topRisks.includes(r))) return { rule: "risk_top", rung: "top" };
  if (risk.some((r) => cfg.strongRisks.includes(r))) return { rule: "risk_strong", rung: "strong" };
  if (m.lines > cfg.largeFileLines || m.large) return { rule: "large_file", rung: "strong" };
  if (m.modules > cfg.maxModules) return { rule: "modules", rung: "strong" };
  return { rule: "small", rung: "default" };
}

export interface RungContext {
  roles: Record<string, Json>;
  ranks: Map<string, Rank[]>;
  /** The resolved top model, if any. */
  top: string | null;
}

/** The rung a model of the builder stands for; null when it cannot be told (an unranked id counts as not below). */
export function rungOfModel(model: string, c: RungContext): Rung | null {
  const base = splitLevel(model.trim()).base;
  if (base === "default") return "default";
  if (base === "strong") return "strong";
  const r = c.roles.builder;
  const own = isObj(r) && typeof r.model === "string" ? splitLevel(r.model).base : null;
  const strong = isObj(r) && isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model ? splitLevel(r.strong.model).base : null;
  if (c.top && base === splitLevel(c.top).base) return "top";
  if (strong && base === strong) return "strong";
  if (own && base === own) return "default";
  if (!strong) return null;
  const up = ranksAbove(c.ranks, base, strong);
  if (up === true) return "top";
  if (up === false) return ranksAbove(c.ranks, strong, base) === true ? "default" : "strong";
  return null;
}

/** The top model: `topRung`, else the next rank above the builder's strong rung, level-capped; null when neither exists. */
export function topModel(config: Json | undefined, roles: Record<string, Json>, maxThinking: unknown, childMaxThinking: unknown): string | null {
  const own = sizingConfig(config).topRung ?? nextRankAboveStrong(config, roles, "builder");
  if (!own) return null;
  const capped = cappedRung(own, maxThinking, childMaxThinking);
  const r = roles.builder;
  const strong = isObj(r) && isObj(r.strong) && typeof r.strong.model === "string" ? splitLevel(r.strong.model).base : null;
  return strong && splitLevel(capped).base === strong ? null : capped;
}

export interface Combination {
  /** The entry launches refused: its explicit model is below the sizing rung and no reason was given. */
  refuse?: boolean;
  /** The entry climbs to the sizing rung (no keyword, base below it). */
  climb?: boolean;
  note: string[];
}

/**
 * How an entry's sizing rung meets its model choice. `target` is the effective rung (top already fell back to strong when no top
 * model exists; `capped` says so). Explicit model: at or above the target it stays; below it needs a reason. No model: raise to the
 * target when the existing logic (`base`) is below it. No strong rung mapped: nothing changes, `capped`.
 */
export function combine(o: { target: Rung; capped: boolean; passed: Rung | null | "none"; base: Rung; reason: boolean; hasStrong: boolean }): Combination {
  const note: string[] = [];
  if (!o.hasStrong) return { note: o.target === "default" && !o.capped ? note : ["capped"] };
  if (o.capped) note.push("capped");
  if (o.passed !== "none") {
    note.unshift("explicit");
    if (o.passed === null || rungIndex(o.passed) >= rungIndex(o.target)) return { note };
    if (!o.reason) return { refuse: true, note };
    note.push("override");
    return { note };
  }
  if (rungIndex(o.base) >= rungIndex(o.target)) return { note };
  return { climb: true, note };
}

/** The refusal for a below-rung explicit model without a reason. */
export function belowMessage(rule: string, rung: Rung, m: Measured): string {
  return `pi-foreman: launch refused [sizing_below]: the builder's model is below the ${rung} rung that launch sizing asks for (rule ${rule}: ${m.files} file(s), ${m.lines} lines, ${m.modules} module(s)). Pass \`reason\` as an extra top-level field of the subagent call saying why the lower model is enough, or launch without \`model\`.`;
}

export interface EntryPlan {
  entry: Json;
  role: string;
  rule: string;
  base: Rung;
  /** The effective sizing rung (top falls back to strong without a top model). */
  target: Rung;
  measured: Measured | null;
  risk: string[];
  /** Strong risk tags the next item or pre-pr reviewer is asked to probe. */
  probe: string[];
  combo: Combination;
}

export interface SizingOptions {
  config: Json | undefined;
  roles: Record<string, Json>;
  ranks: Map<string, Rank[]>;
  cwd: string;
  tier: string | undefined;
  /** A revision climb (ladder.ts revisionClimb) applies to this call: the existing logic already gives strong. */
  revisionClimb: boolean;
  /** The vetted top model (rank policy passed), or null. */
  top: string | null;
}

/**
 * Size every launch entry of a call (after takeSizing): a refusal text, or one plan per entry that carries a trace.
 * An entry that climbs gets `model: "strong"` here (per entry, so LadderState.plan climbs it with reason `sizing`);
 * the top model is written later by the caller, after applyLaunchModels.
 */
export function planSizing(input: Json, taken: Map<Json, Declared>, carried: ReadonlySet<Json>, o: SizingOptions): { block?: string; plans: EntryPlan[]; climbs: Set<Json> } {
  const cfg = sizingConfig(o.config);
  const plans: EntryPlan[] = [];
  const climbs = new Set<Json>();
  const ctx: RungContext = { roles: o.roles, ranks: o.ranks, top: o.top };
  const strongMapped = hasStrongRung(o.roles, "builder");
  // Only the entries that launch now: `narrowLaunch` cut the others away and queued them; they are sized when they relaunch.
  for (const e of launchEntries(input)) {
    const d = taken.get(e);
    if (!d) continue;
    const role = e.agent as string;
    const none: Combination = { note: [] };
    if (role !== "builder") {
      if (carried.has(e)) plans.push({ entry: e, role, rule: "not_builder", base: "default", target: "default", measured: null, risk: [], probe: [], combo: none });
      continue;
    }
    const passedRaw = e.model ?? input.model;
    const passedStr = typeof passedRaw === "string" && passedRaw.trim() ? passedRaw.trim() : null;
    const passed: Rung | null | "none" = passedStr === null ? "none" : rungOfModel(passedStr, ctx);
    const base: Rung = passedStr !== null ? (passed === "none" || passed === null ? "default" : passed) : o.tier === "heavy" || o.revisionClimb ? "strong" : "default";
    if (!d.size && !d.risk) {
      plans.push({ entry: e, role, rule: "undeclared", base, target: "default", measured: null, risk: [], probe: [], combo: none });
      continue;
    }
    const risk = d.risk ?? [];
    const m = measure(d.size, typeof e.cwd === "string" && e.cwd ? e.cwd : o.cwd, o.cwd);
    if (m.invalid) return { block: m.invalid, plans: [], climbs };
    const dec = decide(m, risk, cfg);
    const target: Rung = dec.rung === "top" && !o.top ? "strong" : dec.rung;
    const reasonRaw = e.reason ?? input.reason;
    const combo = combine({ target, capped: target !== dec.rung, passed, base, reason: typeof reasonRaw === "string" && reasonRaw.trim() !== "", hasStrong: strongMapped });
    if (combo.refuse) return { block: belowMessage(dec.rule, target, m), plans: [], climbs };
    if (combo.climb) {
      e.model = "strong";
      climbs.add(e);
    }
    plans.push({ entry: e, role, rule: dec.rule, base, target, measured: m, risk, probe: risk.filter((r) => cfg.strongRisks.includes(r)), combo });
  }
  return { plans, climbs };
}

/** The `launch_sizing` record of a planned entry; `final` is the rung of the model the entry launches on. */
export function sizingTrace(p: EntryPlan, final: Rung): Record<string, unknown> {
  const m = p.measured;
  return {
    event: "launch_sizing",
    role: p.role,
    rule: p.rule,
    rung: final,
    base: p.base,
    ...(m ? { files: m.files, lines: m.lines, declaredLines: m.declaredLines, modules: m.modules, declaredModules: m.declaredModules, outside: m.outside } : {}),
    ...(p.risk.length ? { risk: p.risk.join(",") } : {}),
    ...(p.combo.note.length ? { note: p.combo.note.join(",") } : {}),
  };
}

/** The probe line for an item or pre-pr reviewer after builders launched with these risk tags. */
export function probeLine(tags: Iterable<string>): string {
  return `[pi-foreman risk] ${[...tags].join(", ")}: probe for bypasses (alternate spellings, quoting and chaining, path tricks, races) and list each probe you ran.`;
}

/** Prepend the probe line to a review task; unchanged without tags or when the task already carries one. */
export function prependProbe(task: string, tags: ReadonlySet<string>): string {
  if (tags.size === 0 || task.includes("[pi-foreman risk]")) return task;
  return `${probeLine(tags)}\n\n${task}`;
}
