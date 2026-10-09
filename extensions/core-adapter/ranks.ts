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
export function rankRefusal(config: Json | undefined, foremanModel: string | null, childModel: string): RankRefusal | null {
  const ranks = ranksOf(config);
  const policy = childPolicy(config);
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
