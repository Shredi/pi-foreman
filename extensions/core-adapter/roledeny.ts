// roles.<role>.denyTools: tool-name globs a child of that role never gets (denied, never asked).
// Defaults deny `mcp__*` for the read-only roles. A child whose launch binding cannot be read
// has no role to look up and gets `mcp__*` denied.

export const UNREADABLE_ROLE_DENY: readonly string[] = ["mcp__*"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Glob match where `*` matches any run of characters; everything else is literal. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

/** The deny patterns of a role (`config.roles.<role>.denyTools`); null role = unreadable binding. */
export function denyPatterns(configRoles: unknown, role: string | null | undefined): readonly string[] {
  if (!role || !isObj(configRoles)) return UNREADABLE_ROLE_DENY;
  const r = configRoles[role];
  const list = isObj(r) && Array.isArray(r.denyTools) ? r.denyTools.filter((x): x is string => typeof x === "string") : [];
  return list;
}

/** Denial message when `toolName` matches a pattern of the role, else undefined. */
export function roleToolDenied(configRoles: unknown, role: string | null | undefined, toolName: string): string | undefined {
  const patterns = denyPatterns(configRoles, role);
  if (!patterns.some((p) => globMatch(p, toolName))) return undefined;
  return role ? `\`${toolName}\` is denied for role ${role} (roles.${role}.denyTools)` : `\`${toolName}\` is denied: the child's role could not be read (default deny of mcp__*)`;
}
