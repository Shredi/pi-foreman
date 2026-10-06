// Model map checks (plan D2, D6). Warnings only; nothing here blocks.
//
// D6: every model the map names for a provider (each role's model and strong model, the
// provider's own and its fallback provider's) must be in Pi's model registry, and each provider
// those models use must have auth. Session start checks the active provider, /foreman doctor
// every provider in the map.
// D2: the reviewer (and the senior reviewer: same loop, no extra cost) should not share the
// builder's model family (default or strong) when the provider offers a model of another family.
import { splitLevel } from "./launchmodel.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export interface RegistryLike {
  find(provider: string, modelId: string): unknown;
  getProviderAuthStatus?(provider: string): { configured: boolean };
  getAvailable?(): { provider: string; id: string }[];
}

const FAMILIES: [RegExp, string][] = [
  [/claude|anthropic/, "claude"],
  [/(^|[^a-z])(gpt|chatgpt|codex|o[1-9])([^a-z]|$)|openai/, "gpt"],
  [/gemini|gemma/, "gemini"],
  [/llama/, "llama"],
  [/mistral|mixtral|codestral|magistral|devstral|ministral/, "mistral"],
  [/qwen|qwq/, "qwen"],
  [/deepseek/, "deepseek"],
  [/grok/, "grok"],
];

/** Model family of a model id (`provider/` and a `:level` suffix are ignored): a small heuristic table, else the first id token. */
export function modelFamily(spec: string): string {
  const id = splitLevel(spec.trim()).base.toLowerCase();
  for (const [re, fam] of FAMILIES) if (re.test(id)) return fam;
  const last = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return last.split(/[-_.:\s]+/).find(Boolean) ?? last;
}

/** `provider/id[:level]` -> {provider, id}; a bare id belongs to `dflt`. */
export function splitSpec(spec: string, dflt: string): { provider: string; id: string } {
  const base = splitLevel(spec.trim()).base;
  const i = base.indexOf("/");
  return i > 0 ? { provider: base.slice(0, i), id: base.slice(i + 1) } : { provider: dflt, id: base };
}

export interface Mapped {
  role: string;
  strength: "default" | "strong";
  /** Provider whose map entry names it (the provider itself or its fallback). */
  mapProvider: string;
  provider: string;
  id: string;
}

/** Every model the map names for `provider`: its own role entries and its fallback provider's. */
export function mappedModels(config: Json, provider: string): Mapped[] {
  const providers = isObj(config.providers) ? config.providers : {};
  const own = isObj(providers[provider]) ? (providers[provider] as Json) : {};
  const fb = isObj(own.fallback) && typeof own.fallback.provider === "string" ? own.fallback.provider : null;
  const out: Mapped[] = [];
  for (const p of fb && fb !== provider ? [provider, fb] : [provider]) {
    const roles = isObj(providers[p]) && isObj((providers[p] as Json).roles) ? ((providers[p] as Json).roles as Json) : {};
    for (const [role, e] of Object.entries(roles)) {
      if (!isObj(e)) continue;
      if (typeof e.model === "string" && e.model) out.push({ role, strength: "default", mapProvider: p, ...splitSpec(e.model, p) });
      if (isObj(e.strong) && typeof e.strong.model === "string" && e.strong.model) out.push({ role, strength: "strong", mapProvider: p, ...splitSpec(e.strong.model, p) });
    }
  }
  return out;
}

/** One line per gap for `provider`: a mapped model the registry lacks, a provider without auth. */
export function modelGaps(config: Json, provider: string, registry: RegistryLike): string[] {
  const gaps: string[] = [];
  const models = mappedModels(config, provider);
  const seen = new Set<string>();
  for (const m of models) {
    const key = `${m.provider}/${m.id}`;
    let found = false;
    try {
      found = !!registry.find(m.provider, m.id);
    } catch {
      found = false;
    }
    if (!found) gaps.push(`model ${key} (providers.${m.mapProvider}.roles.${m.role}${m.strength === "strong" ? ".strong" : ""}) is not in the model registry`);
    seen.add(m.provider);
  }
  for (const p of seen) {
    let configured = false;
    try {
      configured = registry.getProviderAuthStatus ? registry.getProviderAuthStatus(p).configured : true;
    } catch {
      configured = false;
    }
    if (!configured) gaps.push(`no auth for provider ${p}, which the map for ${provider} uses`);
  }
  return gaps;
}

/**
 * Reviewer and senior reviewer vs the builder (default and strong), from the roles resolved for
 * `provider`: a warning when they share a family and the registry lists an available model of
 * another family for that provider.
 */
export function familyWarnings(roles: Record<string, Json>, provider: string, registry: RegistryLike): string[] {
  const modelOf = (role: string, strong = false): string | null => {
    const r = roles[role];
    const v = strong ? (isObj(r) && isObj(r.strong) ? r.strong.model : undefined) : isObj(r) ? r.model : undefined;
    return typeof v === "string" && v ? v : null;
  };
  const builder = [modelOf("builder"), modelOf("builder", true)].filter((m): m is string => !!m).map(modelFamily);
  if (builder.length === 0) return [];
  let available: { provider: string; id: string }[] = [];
  try {
    available = registry.getAvailable ? registry.getAvailable().filter((m) => m && m.provider === provider) : [];
  } catch {
    available = [];
  }
  const out: string[] = [];
  for (const role of ["reviewer", "senior-reviewer"]) {
    const m = modelOf(role);
    if (!m) continue;
    const fam = modelFamily(m);
    if (!builder.includes(fam)) continue;
    const other = available.find((a) => !builder.includes(modelFamily(a.id)));
    if (!other) continue;
    out.push(`pi-foreman: the ${role} (${m}) and the builder share the model family ${fam} on ${provider}, so the review tends to share the builder's blind spots. ${provider} also offers ${modelFamily(other.id)} (for example ${provider}/${other.id}): consider mapping providers.${provider}.roles.${role}.model to it.`);
  }
  return out;
}
