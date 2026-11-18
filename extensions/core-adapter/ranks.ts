// Rank policy for child models (frugal roles, ruling of 09.10.): which models a foreman may launch.
//
// `providers.<p>.ranks` is an ordered list of {match: <model-id glob>, tier: <int, 0 = top>},
// highest first. Tiers are plain numbers compared across providers: the foreman's tier and a
// child's tier are both looked up in the union of every provider's list (the model's own
// provider's list first, then the others in key order; the first matching entry wins). A glob
// matches the bare model id, or `<provider>/<id>` when it contains a slash; `*` and `?` only.
//
// `ladder.childPolicy` (top level, one policy for every provider, since tiers cross providers):
//   "below" (default)  a child's tier must be strictly below (a larger number than) the foreman's
//   "at-or-below"      the child's tier may equal the foreman's
//   "any"              no rank check
// With ranks configured, a model in no list is unranked: allowed only under "any"; an unranked
// foreman can launch nothing ranked-checked either (fail closed). With no ranks anywhere the
// policy is inert (ASSUMPTION A1), so the shipped defaults behave as before.
// `ladder.rolePolicy.<role>` overrides the policy for one role; an explicit launch `model:` is the model checked.
// `ladder.equalOnStrongRisk` (default false; index.ts rank loop): under "below" a builder whose risk tag sent it to its strong rung may
// run on the foreman's own model when that is exactly the strong model; `rankTie` says whether a refusal is such a tie of two ranked models.
import { get, type Json } from "./config.ts";
import { splitLevel } from "./launchmodel.ts";

export const CHILD_POLICIES = ["below", "at-or-below", "any"] as const;
export type ChildPolicy = (typeof CHILD_POLICIES)[number];

export interface Rank {
  match: string;
  tier: number;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** ladder.childPolicy, "below" unless set to another known value. */
export function childPolicy(config: Json | undefined): ChildPolicy {
  const v = get(config, "ladder.childPolicy");
  return (CHILD_POLICIES as readonly unknown[]).includes(v) ? (v as ChildPolicy) : "below";
}

/** ladder.rolePolicy.<role> when set to a known value, else ladder.childPolicy. */
export function rolePolicy(config: Json | undefined, role?: string): ChildPolicy {
  const v = role ? get(config, `ladder.rolePolicy.${role}`) : undefined;
  return (CHILD_POLICIES as readonly unknown[]).includes(v) ? (v as ChildPolicy) : childPolicy(config);
}

/** ladder.equalOnStrongRisk: true only for a literal `true`. */
export function equalOnStrongRisk(config: Json | undefined): boolean {
  return get(config, "ladder.equalOnStrongRisk") === true;
}

/** Every provider's valid ranks entries, keyed by provider (key order kept). */
export function ranksOf(config: Json | undefined): Map<string, Rank[]> {
  const out = new Map<string, Rank[]>();
  const providers = get(config, "providers");
  if (!isObj(providers)) return out;
  for (const [p, entry] of Object.entries(providers)) {
    const list = isObj(entry) && Array.isArray(entry.ranks) ? entry.ranks : [];
    const ok = list.filter((r): r is Rank => isObj(r) && typeof r.match === "string" && r.match !== "" && Number.isInteger(r.tier) && (r.tier as number) >= 0);
    if (ok.length) out.set(p, ok);
  }
  return out;
}

function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** The tier of `<provider>/<id>[:level]`, or null when unranked. */
export function tierOf(ranks: Map<string, Rank[]>, model: string): number | null {
  const base = splitLevel(model.trim()).base;
  const slash = base.indexOf("/");
  const provider = slash > 0 ? base.slice(0, slash) : "";
  const id = slash > 0 ? base.slice(slash + 1) : base;
  const order = [...(ranks.has(provider) ? [provider] : []), ...[...ranks.keys()].filter((p) => p !== provider)];
  for (const p of order) {
    for (const r of ranks.get(p) ?? []) if (globRe(r.match).test(r.match.includes("/") ? base : id)) return r.tier;
  }
  return null;
}

export interface RankRefusal {
  policy: ChildPolicy;
  foreman: string;
  requested: string;
  message: string;
}

/**
 * Null when the foreman (`foremanModel`, `<provider>/<id>`) may launch `childModel` under the
 * policy, else the refusal (trace fields plus the message for the foreman).
 */
export function rankRefusal(config: Json | undefined, foremanModel: string | null, childModel: string, role?: string): RankRefusal | null {
  const ranks = ranksOf(config);
  const policy = rolePolicy(config, role);
  if (ranks.size === 0 || policy === "any") return null;
  const requested = splitLevel(childModel.trim()).base;
  const foreman = foremanModel ?? "unknown";
  const fTier = foremanModel ? tierOf(ranks, foremanModel) : null;
  const cTier = tierOf(ranks, requested);
  const fix = 'Add a ranks entry for it, map the role to a lower-ranked model, or set ladder.childPolicy to "any" in the user or overlay config.';
  const refuse = (why: string): RankRefusal => ({ policy, foreman, requested, message: `pi-foreman: launch refused [rank_policy:${policy}]: ${why} ${fix}` });
  if (cTier === null) return refuse(`child model ${requested} is unranked (in no providers.<p>.ranks list).`);
  if (fTier === null) return refuse(`the foreman model ${foreman} is unranked, so no child rank can be checked against it.`);
  const ok = policy === "below" ? cTier > fTier : cTier >= fTier;
  return ok ? null : refuse(`child model ${requested} (tier ${cTier}) is not ${policy === "below" ? "below" : "at or below"} the foreman model ${foreman} (tier ${fTier}).`);
}

/** Whether `childModel` and the foreman are both ranked at the same tier while `role`'s policy is "below" (never with an unranked model). */
export function rankTie(config: Json | undefined, foremanModel: string | null, childModel: string, role: string): boolean {
  const ranks = ranksOf(config);
  if (ranks.size === 0 || !foremanModel || rolePolicy(config, role) !== "below") return false;
  const f = tierOf(ranks, foremanModel);
  return f !== null && f === tierOf(ranks, childModel);
}

/** The sentence a tie refusal gets while ladder.equalOnStrongRisk is off. */
export function equalKeySentence(): string {
  return "A builder launch whose risk tag sends it to the strong rung may run on the foreman's own model when ladder.equalOnStrongRisk is true (user or overlay config).";
}

/** The first refusal of `childModel` for any of `roles` (each under its own rolePolicy); no roles = ladder.childPolicy. */
export function rankRefusalFor(config: Json | undefined, foremanModel: string | null, childModel: string, roles: readonly string[]): RankRefusal | null {
  for (const r of roles.length ? roles : [undefined]) {
    const no = rankRefusal(config, foremanModel, childModel, r);
    if (no) return no;
  }
  return null;
}

/** The foreman-model fix a refusal under `role`'s policy ends with. */
const rankedAbove = (config: Json | undefined, role: string): string => (rolePolicy(config, role) === "below" ? "above" : "at or above");

/**
 * The sentence a refusal of `childModel` gets when it is the normal (mapped default) model of the first of `roles` whose own policy refuses it,
 * both models ranked: the cause and the way out. Null for a strong rung or an explicit other model (not the role's normal model) and for an unranked model.
 */
export function normalModelSentence(config: Json | undefined, foremanModel: string | null, childModel: string, roles: readonly string[], roleMap: Record<string, Json>): string | null {
  const role = roles.find((r) => rankRefusal(config, foremanModel, childModel, r) !== null);
  if (!role || !foremanModel) return null;
  const ranks = ranksOf(config);
  const base = splitLevel(childModel.trim()).base;
  const normal = get(roleMap, `${role}.model`);
  if (tierOf(ranks, base) === null || tierOf(ranks, foremanModel) === null || typeof normal !== "string" || splitLevel(normal.trim()).base !== base) return null;
  return `${base} is the ${role}'s normal model: run the foreman on a model ranked ${rankedAbove(config, role)} it.`;
}

/**
 * `/foreman doctor`: the roles whose normal model the foreman model cannot launch (each under its own policy), as {message, fix}. An unranked
 * model (the role's or the foreman's) is reported as a missing ranks entry. Empty with no ranks configured.
 */
export function rankDoctorFindings(config: Json | undefined, foremanModel: string | null, roleMap: Record<string, Json>): { message: string; fix: string }[] {
  const out: { message: string; fix: string }[] = [];
  const ranks = ranksOf(config);
  if (ranks.size === 0 || !foremanModel) return out;
  for (const role of ["explorer", "builder", "reviewer"]) {
    const normal = get(roleMap, `${role}.model`);
    if (typeof normal !== "string" || normal === "" || rolePolicy(config, role) === "any") continue;
    const no = rankRefusal(config, foremanModel, normal, role);
    if (!no) continue;
    const model = splitLevel(normal.trim()).base;
    const unranked = tierOf(ranks, model) === null ? model : tierOf(ranks, foremanModel) === null ? foremanModel : null;
    if (unranked !== null) out.push({ message: `${role}'s normal model ${model} cannot be rank-checked: ${unranked} is in no providers.<p>.ranks list`, fix: "add a ranks entry for it" });
    else out.push({ message: `${role}'s normal model ${model} is not launchable under the foreman model ${foremanModel} (rank policy ${no.policy})`, fix: `run the foreman on a model ranked ${rankedAbove(config, role)} it, or map the role to a lower-ranked model` });
  }
  return out;
}

/** An explicit launch model is honoured only with ranks configured, ranked, and allowed for `role`. */
export function explicitModelAllowed(config: Json | undefined, foremanModel: string | null, childModel: string, role: string): boolean {
  const ranks = ranksOf(config);
  return ranks.size > 0 && tierOf(ranks, childModel) !== null && rankRefusal(config, foremanModel, childModel, role) === null;
}

/** Why an explicit launch model is not honoured for `role` (null when it is): the reason a refusal or a `model switched` line gives. */
export function explicitModelReason(config: Json | undefined, foremanModel: string | null, childModel: string, role: string): string | null {
  const base = splitLevel(childModel.trim()).base;
  if (!base.includes("/")) return "model id needs the provider/ prefix";
  const ranks = ranksOf(config);
  if (ranks.size === 0) return "no rank rules configured (run foreman config apply-preset or set providers.<p>.ranks)";
  if (tierOf(ranks, base) === null) return "model not ranked";
  return rankRefusal(config, foremanModel, base, role)?.message.replace(/^pi-foreman: launch refused /, "") ?? null;
}

/** The models an explicit `model` may name for `role`: the literal ranks entries and `known` models that are ranked and inside the role's rank policy. */
export function allowedExplicitModels(config: Json | undefined, foremanModel: string | null, role: string, known: readonly string[]): string[] {
  const out = new Set<string>();
  for (const [provider, list] of ranksOf(config)) for (const r of list) if (!/[*?]/.test(r.match)) out.add(r.match.includes("/") ? r.match : `${provider}/${r.match}`);
  for (const m of known) out.add(splitLevel(m.trim()).base);
  return [...out].filter((m) => m.includes("/") && explicitModelAllowed(config, foremanModel, m, role));
}

/** Agents (roles) of the `subagent` call's entries whose launch model is `model`. */
export function rolesOfModel(input: Json, model: string): string[] {
  const out: string[] = [];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!isObj(e)) continue;
      if (typeof e.agent === "string" && e.model === model) out.push(e.agent);
      visit(e.parallel);
    }
  };
  if (typeof input.agent === "string" && input.model === model) out.push(input.agent);
  visit(input.tasks);
  visit(input.chain);
  return out;
}

/** Every model a `subagent` call launches (after applyLaunchModels wrote them): top level and each entry. */
export function launchedModels(input: Json): string[] {
  const out: string[] = [];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!isObj(e)) continue;
      if (typeof e.agent === "string" && typeof e.model === "string") out.push(e.model);
      visit(e.parallel);
    }
  };
  if (typeof input.agent === "string" && typeof input.model === "string") out.push(input.model);
  visit(input.tasks);
  visit(input.chain);
  return out;
}
