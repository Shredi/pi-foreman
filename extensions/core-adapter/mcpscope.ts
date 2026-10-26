// MCP scope of a child (round 68): which servers and tools a child of a role may load on demand.
// `roles.<role>.mcp` is the ceiling (entries `server` or `server/tool`), `denyTools` wins over it, and a launch's
// `mcp` list narrows it. Pure functions; the child wiring is mcpchild.ts, the launch validation is mcplaunch.ts.
import { denyPatterns, globMatch } from "./roledeny.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What a child may load: whole servers, and per server the single tools of `server/tool` entries. */
export interface McpAllowed {
  /** Servers allowed with all their tools (names as written). */
  servers: string[];
  /** Servers allowed only for the listed tools (names as written); never also in `servers`. */
  tools: Record<string, string[]>;
}

export const NO_MCP: McpAllowed = Object.freeze({ servers: [], tools: {} }) as McpAllowed;

/** Server names compare in both forms: `-` and `_` are one. */
export const serverKey = (name: string): string => name.replace(/-/g, "_");

/** The tool-name form of a server or tool name (a character outside `[A-Za-z0-9_]` becomes `_`). */
const sanitized = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");

/** Split a `server` or `server/tool` entry; null for an empty or malformed entry. */
export function splitEntry(entry: unknown): { server: string; tool: string | null } | null {
  if (typeof entry !== "string") return null;
  const text = entry.trim();
  if (!text) return null;
  const slash = text.indexOf("/");
  if (slash < 0) return { server: text, tool: null };
  const server = text.slice(0, slash);
  const tool = text.slice(slash + 1);
  return server && tool ? { server, tool } : null;
}

/** The entries of `roles.<role>.mcp` (strings only). */
export function roleMcpEntries(configRoles: unknown, role: string | null | undefined): string[] {
  if (!role || !isObj(configRoles)) return [];
  const r = configRoles[role];
  return isObj(r) && Array.isArray(r.mcp) ? r.mcp.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

/** Would a deny pattern of the role match a tool of this entry (`mcp__<server>__<tool>`)? */
function denied(patterns: readonly string[], server: string, tool: string | null): boolean {
  const probe = `mcp__${sanitized(server)}__${tool === null ? "x" : sanitized(tool)}`;
  return patterns.some((p) => globMatch(p, probe));
}

function build(entries: Iterable<string>, patterns: readonly string[]): McpAllowed {
  const whole = new Map<string, string>();
  const single = new Map<string, { server: string; tools: Set<string> }>();
  for (const entry of entries) {
    const e = splitEntry(entry);
    if (!e || denied(patterns, e.server, e.tool)) continue;
    const key = serverKey(e.server);
    if (e.tool === null) {
      if (!whole.has(key)) whole.set(key, e.server);
    } else {
      const slot = single.get(key) ?? { server: e.server, tools: new Set<string>() };
      slot.tools.add(e.tool);
      single.set(key, slot);
    }
  }
  const tools: Record<string, string[]> = {};
  for (const [key, slot] of single) if (!whole.has(key)) tools[slot.server] = [...slot.tools];
  return { servers: [...whole.values()], tools };
}

/**
 * The servers and tools a child of `role` may load: the role's list, minus entries its `denyTools` would deny,
 * narrowed by the launch list when given (`undefined`/`null` = no narrowing; `[]` = nothing). A launch entry
 * counts only inside the ceiling: `server` if the role lists that server, `server/tool` if the role lists the
 * server or the same entry. A bare `server` entry wins over `server/tool` entries of that server.
 */
export function allowedMcp(configRoles: unknown, role: string | null | undefined, launchMcp?: readonly string[] | null): McpAllowed {
  const ceiling = roleMcpEntries(configRoles, role);
  if (ceiling.length === 0) return { servers: [], tools: {} };
  const patterns = denyPatterns(configRoles, role);
  if (!Array.isArray(launchMcp)) return build(ceiling, patterns);
  const base = build(ceiling, patterns);
  const kept: string[] = [];
  for (const entry of launchMcp) {
    const e = splitEntry(entry);
    if (!e) continue;
    const key = serverKey(e.server);
    const wholeServer = base.servers.some((s) => serverKey(s) === key);
    const toolsOf = Object.entries(base.tools).find(([s]) => serverKey(s) === key)?.[1];
    if (e.tool === null ? wholeServer : wholeServer || (toolsOf?.includes(e.tool) ?? false)) kept.push(e.tool === null ? e.server : `${e.server}/${e.tool}`);
  }
  return build(kept, patterns);
}

/** Is a launch `entry` inside the role's ceiling? `server` only if the role lists that server; `server/tool` if the role lists the server or that same entry. */
export function inCeiling(configRoles: unknown, role: string | null | undefined, entry: string): boolean {
  const e = splitEntry(entry);
  if (!e) return false;
  return roleMcpEntries(configRoles, role).some((own) => {
    const o = splitEntry(own);
    if (!o || serverKey(o.server) !== serverKey(e.server)) return false;
    return o.tool === null || (e.tool !== null && o.tool === e.tool);
  });
}

/** Nothing allowed. */
export const mcpEmpty = (allowed: McpAllowed): boolean => allowed.servers.length === 0 && Object.keys(allowed.tools).length === 0;

/** Is the tool labeled `server/tool` (the label Pi's MCP extension gives a tool it registers) inside the allowed set? */
export function mcpCallAllowed(allowed: McpAllowed, label: string | null | undefined): boolean {
  const e = typeof label === "string" ? splitEntry(label) : null;
  if (!e || e.tool === null) return false;
  const key = serverKey(e.server);
  if (allowed.servers.some((s) => serverKey(s) === key)) return true;
  const own = Object.entries(allowed.tools).find(([s]) => serverKey(s) === key)?.[1];
  return own?.includes(e.tool) ?? false;
}

// ---------------------------------------------------------------- config filter (shape of Pi's LoadedMcpConfig)

type Exposure = string;
interface ServerConfig {
  exposure?: Exposure;
  toolExposure?: Record<string, Exposure>;
  [key: string]: unknown;
}
export interface McpEntryLike {
  name: string;
  config: ServerConfig;
  [key: string]: unknown;
}
export interface McpLoadedLike {
  servers: McpEntryLike[];
  autoEnableCodemode?: boolean;
  errors: string[];
  [key: string]: unknown;
}

/** In a child nothing is declared up front: `direct` becomes `deferred`, the rest stays. */
const childExposure = (e: Exposure): Exposure => (e === "direct" ? "deferred" : e);

const patternRe = (pattern: string): RegExp => new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

/** Pi's `getMcpToolExposure`: the exact `toolExposure` entry, else the first matching pattern, else the server's exposure (default codemode). */
export function toolExposureOf(config: ServerConfig, tool: string): Exposure {
  const overrides = config.toolExposure ?? {};
  if (overrides[tool] !== undefined) return overrides[tool];
  for (const [pattern, exposure] of Object.entries(overrides)) if (pattern.includes("*") && patternRe(pattern).test(tool)) return exposure;
  return config.exposure ?? "codemode";
}

/**
 * Pi's loaded MCP config reduced to what a child may load: servers outside `allowed` are dropped; per allowed server
 * `direct` becomes `deferred` (also in `toolExposure`), `hidden` drops the server; a server allowed only through
 * `server/tool` entries becomes `hidden` with a `toolExposure` of exactly the allowed tools, each mapped from its
 * original resolved exposure (every other override, wildcards included, is dropped). `enabled`, `autoEnableCodemode`,
 * `errors` and the rest pass through. The input is not changed.
 */
export function filterMcpConfig<T extends McpLoadedLike>(loaded: T, allowed: McpAllowed): T {
  const servers: McpEntryLike[] = [];
  for (const entry of loaded.servers) {
    const key = serverKey(entry.name);
    const config = entry.config;
    if (allowed.servers.some((s) => serverKey(s) === key)) {
      const exposure = config.exposure ?? "codemode";
      if (exposure === "hidden") continue;
      const next: ServerConfig = { ...config, exposure: childExposure(exposure) };
      if (config.toolExposure) next.toolExposure = Object.fromEntries(Object.entries(config.toolExposure).map(([t, e]) => [t, childExposure(e)]));
      servers.push({ ...entry, config: next });
      continue;
    }
    const own = Object.entries(allowed.tools).find(([s]) => serverKey(s) === key)?.[1];
    if (!own) continue;
    const toolExposure: Record<string, Exposure> = {};
    for (const tool of own) toolExposure[tool] = childExposure(toolExposureOf(config, tool));
    if (Object.values(toolExposure).every((e) => e === "hidden")) continue;
    servers.push({ ...entry, config: { ...config, exposure: "hidden", toolExposure } });
  }
  return { ...loaded, servers };
}
