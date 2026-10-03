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

/**
 * Model id for one launch of `role`: provider and model from the map (`roles[role].model`,
 * a full `<provider>/<model>` id); the level is the foreman's own when it passed one (capped
 * at `maxThinking`), else the role's mapped thinking (already capped by foreman_config); no
 * suffix when neither is set. `override` is set when the foreman named a different model.
 */
export function launchModel(role: string, roles: Record<string, Json>, passed: unknown, maxThinking: unknown): { model: string; override?: ModelOverride } | undefined {
  const r = roles[role];
  if (!isObj(r) || typeof r.model !== "string" || r.model === "") return undefined;
  const mapped = splitLevel(r.model);
  const foreman = typeof passed === "string" ? splitLevel(passed.trim()) : { base: "", level: null };
  const level = foreman.level ? clampLevel(foreman.level, maxThinking) : isLevel(r.thinking) ? r.thinking : mapped.level;
  const model = level ? `${mapped.base}:${level}` : mapped.base;
  if (foreman.base !== "" && foreman.base !== mapped.base) return { model, override: { role, model: mapped.base } };
  return { model };
}

/**
 * Write the mapped model into a `subagent` call in place: the top-level `model` for a single
 * `agent` launch, each entry's `model` in `tasks`, `chain` and `chain[].parallel`. A top-level
 * model passed with tasks/chain counts as the foreman's choice for entries without their own.
 * Management calls (non-empty `action`) are left alone. Returns the overrides to trace.
 */
export function applyLaunchModels(input: Json, roles: Record<string, Json>, maxThinking: unknown): ModelOverride[] {
  if (!isObj(input)) return [];
  if (typeof input.action === "string" && input.action !== "") return [];
  const overrides: ModelOverride[] = [];
  const set = (o: Json, passed: unknown): void => {
    if (typeof o.agent !== "string" || o.agent === "") return;
    const res = launchModel(o.agent, roles, passed, maxThinking);
    if (!res) return;
    o.model = res.model;
    if (res.override) overrides.push(res.override);
  };
  const composite = Array.isArray(input.tasks) || Array.isArray(input.chain);
  if (!composite) {
    set(input, input.model);
    return overrides;
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
  return overrides;
}
