// The role map decides every child's model at launch (design §4). pi-subagents 0.75.0 reads
// its own model sources (user settings block, frontmatter, parent model); a role map from the
// project or session layer would be ignored there, so the adapter writes the resolved model
// into the launch itself, after the allowlist and model checks.
//
// Schema (pi-subagents 0.75.0, src/extension/schemas.js): top-level `model` is "Child model
// provider/id ... Suffix :off/minimal/low/medium/high/xhigh/max overrides agent thinking
// default". A bare `:high` fails for native children, so the value is always the full id
// `<provider>/<model>[:<level>]`. `tasks[]`, `chain[]` and `chain[].parallel[]` entries are
// validated before the tool_call hook; the executor reads an entry's own `model`, which wins
// over the top-level one, so each entry gets its role's model and the top-level one is dropped.
// The default schema declares no `tasks`/`chain` (they are admitted at runtime, entries
// unchecked); with `disabledFeatures: workflow-scripts` an entry allows only agent and task,
// so a per-entry keyword from the foreman is rejected there and only the top-level one applies.

import { isActionCall } from "./actions.ts";

type Json = Record<string, unknown>;

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isLevel = (v: unknown): v is Thinking => typeof v === "string" && (THINKING as readonly string[]).includes(v);

/** Split a known `:<level>` suffix off a model string: {base, level}. */
export function splitLevel(model: string): { base: string; level: Thinking | null } {
  const i = model.lastIndexOf(":");
  if (i >= 0 && isLevel(model.slice(i + 1))) return { base: model.slice(0, i), level: model.slice(i + 1) as Thinking };
  return { base: model, level: null };
}

/** `level` capped at `ceiling` (foreman_config cap_thinking); unknown ceilings do not cap. */
export function clampLevel(level: Thinking, ceiling: unknown): Thinking {
  if (!isLevel(ceiling)) return level;
  return THINKING.indexOf(level) <= THINKING.indexOf(ceiling) ? level : ceiling;
}

export interface ModelOverride {
  role: string;
  /** The mapped model that replaced the foreman's (base id, no level). */
  model: string;
}

export type Tier = "trivial" | "standard" | "heavy";

/** Strength keywords the foreman may pass as `model`, optionally with a `:<level>` suffix. */
export const STRENGTHS = ["default", "strong"] as const;

export interface LaunchOptions {
  /** The foreman session's ceremony tier: a heavy tier launches the builder on its strong model. */
  tier?: Tier;
  /** Launch the builder on its strong model when no keyword is passed (H3 revision relaunch). */
  preferStrong?: boolean;
  /** Active provider, named in notices. */
  provider?: string;
}

export interface LaunchResult {
  model: string;
  override?: ModelOverride;
  /** One line for the tool result: strong was asked for, but no strong model is mapped. */
  notice?: string;
}

/**
 * Model id for one launch of `role`, from the map (`roles[role]`, resolved by foreman_config).
 * Strength: the keyword `default` or `strong` when the foreman passed one; with no keyword,
 * `strong` for a builder launch on a heavy tier or with `preferStrong`, else `default`.
 * `strong` uses `roles[role].strong` ({model, thinking}); when none is mapped the default model
 * is used, and `notice` says so when strong was asked for (keyword or `preferStrong`; a heavy
 * tier without a strong model stays silent). A raw model id is no keyword: it is replaced by the
 * map at the strength above and reported as `override`. The level is the foreman's own when it
 * passed one (capped at `maxThinking`), else the chosen model's mapped thinking (already capped
 * by foreman_config); no suffix when neither is set.
 */
export function launchModel(role: string, roles: Record<string, Json>, passed: unknown, maxThinking: unknown, opts: LaunchOptions = {}): LaunchResult | undefined {
  const r = roles[role];
  if (!isObj(r) || typeof r.model !== "string" || r.model === "") return undefined;
  const foreman = typeof passed === "string" ? splitLevel(passed.trim()) : { base: "", level: null };
  const keyword = (STRENGTHS as readonly string[]).includes(foreman.base) ? foreman.base : null;
  const asked = keyword === "strong" || (keyword === null && role === "builder" && opts.preferStrong === true);
  const wantStrong = asked || (keyword === null && role === "builder" && opts.tier === "heavy");
  const strong = isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model !== "" ? r.strong : null;
  const pick = wantStrong && strong ? strong : r;
  const mapped = splitLevel(pick.model as string);
  const level = foreman.level ? clampLevel(foreman.level, maxThinking) : isLevel(pick.thinking) ? pick.thinking : mapped.level;
  const model = level ? `${mapped.base}:${level}` : mapped.base;
  const out: LaunchResult = { model };
  if (keyword === null && foreman.base !== "" && foreman.base !== mapped.base) out.override = { role, model: mapped.base };
  if (asked && !strong) out.notice = `pi-foreman: no strong model mapped for ${role} on ${opts.provider ?? "the active provider"}; launched on ${model}`;
  return out;
}

/** What applyLaunchModels changed: overrides to trace, notices for the tool result. */
export interface LaunchModels {
  overrides: ModelOverride[];
  /** Strong asked for but unmapped: the role, the model actually used and the line to show. */
  notices: { role: string; model: string; text: string }[];
}

/**
 * Write the mapped model into a `subagent` call in place: the top-level `model` for a single
 * `agent` launch, each entry's `model` in `tasks`, `chain` and `chain[].parallel`. A top-level
 * model (or keyword) passed with tasks/chain counts as the foreman's choice for entries without
 * their own. Calls with an action are left alone: management calls launch nothing, and `resume`
 * reuses the persisted model (actions.ts checks it against the map).
 */
export function applyLaunchModels(input: Json, roles: Record<string, Json>, maxThinking: unknown, opts: LaunchOptions = {}): LaunchModels {
  const out: LaunchModels = { overrides: [], notices: [] };
  if (!isObj(input)) return out;
  if (isActionCall(input)) return out;
  const set = (o: Json, passed: unknown): void => {
    if (typeof o.agent !== "string" || o.agent === "") return;
    const res = launchModel(o.agent, roles, passed, maxThinking, opts);
    if (!res) return;
    o.model = res.model;
    if (res.override) out.overrides.push(res.override);
    if (res.notice && !out.notices.some((n) => n.text === res.notice)) out.notices.push({ role: o.agent, model: res.model, text: res.notice });
  };
  const composite = Array.isArray(input.tasks) || Array.isArray(input.chain);
  if (!composite) {
    set(input, input.model);
    return out;
  }
  const top = input.model;
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isObj(entry)) continue;
      set(entry, entry.model ?? top);
      visit(entry.parallel);
    }
  };
  visit(input.tasks);
  visit(input.chain);
  delete input.model;
  return out;
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** `roles.<id>.timeoutMinutes` of the merged config in ms, or undefined when unset. */
export function roleTimeoutMs(configRoles: unknown, role: string): number | undefined {
  const r = isObj(configRoles) ? configRoles[role] : undefined;
  return isObj(r) && posInt(r.timeoutMinutes) ? r.timeoutMinutes * 60_000 : undefined;
}

/**
 * Write the run-time limit into a `subagent` launch in place (D7): top-level `timeoutMs` = the
 * role's `timeoutMinutes`; a foreman `timeoutMs` (or its alias `maxRuntimeMs`, which is dropped)
 * stays only when it is lower. pi-subagents 0.75.0 honours the top-level value as the run
 * deadline of a detached single launch, and for tasks/chain as the parent deadline of the whole
 * run; it reads no per-entry `timeoutMs`, so none is written. A composite therefore gets the
 * deadline its slowest allowed run needs: `tasks` = the highest entry limit, `chain` = the sum
 * of its steps (a parallel step counts its highest entry). An entry without a limit leaves the
 * call unchanged.
 */
export function applyLaunchTimeouts(input: Json, configRoles: unknown): void {
  if (!isObj(input) || isActionCall(input)) return;
  const limitOf = (o: unknown): number | undefined => (isObj(o) && typeof o.agent === "string" ? roleTimeoutMs(configRoles, o.agent) : undefined);
  const maxOf = (list: unknown[]): number | undefined => {
    const ms = list.map(limitOf);
    return ms.length > 0 && ms.every(posInt) ? Math.max(...(ms as number[])) : undefined;
  };
  let limit: number | undefined;
  if (Array.isArray(input.tasks)) limit = maxOf(input.tasks);
  else if (Array.isArray(input.chain)) {
    let sum: number | undefined = 0;
    for (const step of input.chain) {
      const ms = isObj(step) && Array.isArray(step.parallel) ? maxOf(step.parallel) : limitOf(step);
      sum = sum !== undefined && posInt(ms) ? sum + ms : undefined;
    }
    limit = sum || undefined;
  } else limit = limitOf(input);
  if (limit === undefined) return;
  const passed = input.timeoutMs ?? input.maxRuntimeMs;
  delete input.maxRuntimeMs;
  input.timeoutMs = posInt(passed) && passed < limit ? passed : limit;
}
