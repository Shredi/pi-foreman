// Role allowlist (design §9): the foreman launches only configured pi-foreman child roles.
// pi-subagents ships builtin agents (worker, scout, ...) that carry none of the role
// definitions; a launch naming one is refused (fail closed). The allowed ids are the keys of
// the merged config `roles` minus `foreman`, so overlay-added roles are allowed too.
import { subagentAgents } from "./payload.ts";

type Json = Record<string, unknown>;

/** Child role ids from the merged config `roles` object (everything but `foreman`). */
export function childRoleIds(roles: unknown): string[] {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return [];
  return Object.keys(roles).filter((id) => id !== "foreman");
}

/**
 * Block reason for a `subagent` call that names an agent outside `allowed`, or undefined.
 * Management calls (non-empty `action`) pass. Checks the top-level `agent` and every agent in
 * `tasks[]`, `chain[]` and `chain[].parallel[]`.
 */
export function roleLaunchBlock(input: Json, allowed: readonly string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.action === "string" && input.action !== "") return undefined;
  const refused = subagentAgents(input).find((a) => !allowed.includes(a));
  if (refused === undefined) return undefined;
  const list = allowed.length ? allowed.join(", ") : "(none configured)";
  return `pi-foreman: agent '${refused}' is not a pi-foreman role; launch one of: ${list}`;
}
