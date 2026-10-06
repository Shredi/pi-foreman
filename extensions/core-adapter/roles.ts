// Role allowlist (design §9): the foreman launches only configured pi-foreman child roles.
// pi-subagents ships builtin agents (worker, scout, ...) that carry none of the role
// definitions; a launch naming one is refused (fail closed). The allowed ids are the keys of
// the merged config `roles` minus `foreman`, so overlay-added roles are allowed too.
import { isManagementCall } from "./actions.ts";
import { subagentAgents } from "./payload.ts";

type Json = Record<string, unknown>;

/** Child role ids from the merged config `roles` object (everything but `foreman`). */
export function childRoleIds(roles: unknown): string[] {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return [];
  return Object.keys(roles).filter((id) => id !== "foreman");
}

/**
 * Block reason for a `subagent` call that names an agent outside `allowed`, or undefined.
 * Allowlisted non-launching actions pass (actions.ts; every other action is checked there). Checks the top-level `agent` and every agent in
 * `tasks[]`, `chain[]` and `chain[].parallel[]`.
 */
export function roleLaunchBlock(input: Json, allowed: readonly string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (isManagementCall(input)) return undefined;
  const refused = subagentAgents(input).find((a) => !allowed.includes(a));
  if (refused === undefined) return undefined;
  const list = allowed.length ? allowed.join(", ") : "(none configured)";
  return `pi-foreman: agent '${refused}' is not a pi-foreman role; launch one of: ${list}`;
}

/** What the model check needs from the merged config (see config.ts MergedConfig). */
export interface RoleResolution {
  /** Provider the `roles` map was resolved for; undefined when no provider is active. */
  provider: string | undefined;
  roles: Record<string, Json>;
  source: "cli" | "defaults";
}

/**
 * Block reason for a `subagent` call that names a role without a resolved model for the active
 * provider, or undefined (design §3: never a silent default). Allowlisted non-launching actions pass. A role
 * passes when `roles[<id>].model` is a non-empty string; foreman_config resolves a provider
 * fallback into that field. Fails closed when the config CLI did not run.
 */
export function roleModelBlock(input: Json, res: RoleResolution): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (isManagementCall(input)) return undefined;
  const agents = subagentAgents(input);
  if (agents.length === 0) return undefined;
  if (res.source !== "cli") {
    return "pi-foreman: the config could not be loaded, so no child role has a resolved model; the launch is blocked. Fix Python and foreman.json (see /foreman doctor) and restart the session.";
  }
  const p = res.provider;
  if (!p) {
    return `pi-foreman: no provider is active, so role '${agents[0]}' has no resolved model; the launch is blocked. Select a model and retry.`;
  }
  const missing = agents.find((a) => {
    const r = res.roles[a];
    return !r || typeof r !== "object" || typeof r.model !== "string" || r.model === "";
  });
  if (missing === undefined) return undefined;
  return `pi-foreman: role '${missing}' has no model for provider '${p}' and no fallback; add providers.${p}.roles.${missing}.model to foreman.json (or a providers.${p}.fallback) and restart the session.`;
}
