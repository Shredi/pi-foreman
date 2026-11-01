// Deferred tool declarations (token diet): rarely used tools stay registered and callable but their declarations are left out of
// requests (`hiddenDeclarations` of the harness `tool_search`); the model finds them through that tool. Pure functions, no Pi imports.

/** Tools that are never hidden: the search itself, codemode, the core file tools and the routing and supervisor tools. */
export const DEFERRED_FLOOR: readonly string[] = ["tool_search", "codemode", "read", "bash", "subagent", "foreman_ledger", "foreman_triage", "contact_supervisor", "subagent_supervisor", "ask_user_question"];

/** The plan-mode tools: matched like any pattern, but declared when plan mode was on at session start. */
export const PLAN_MODE_TOOLS: readonly string[] = ["plan_mode_question", "plan_mode_complete"];

/** Session section name of the hint. */
export const DEFERRED_SECTION = "pi-foreman-deferred";

/** Session custom entry `{names, planMode}`: the un-hidden names and the plan-mode decision at session start, read back on resume and /reload. */
export const DEFERRED_ENTRY = "deferred-loaded";

export interface DeferredLoaded {
  names: string[];
  planMode: boolean;
}

/** The latest `deferred-loaded` entry of a branch, else null. */
export function latestDeferredLoaded(entries: readonly unknown[]): DeferredLoaded | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: { names?: unknown; planMode?: unknown } } | null;
    if (!e || e.type !== "custom" || e.customType !== DEFERRED_ENTRY) continue;
    const names = Array.isArray(e.data?.names) ? e.data.names.filter((n): n is string => typeof n === "string") : [];
    return { names, planMode: e.data?.planMode === true };
  }
  return null;
}

/** Does `name` match `pattern`: an exact name, or a glob where `*` stands for any run of characters. */
export function matchesPattern(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(name);
}

export interface HiddenInput {
  patterns: readonly string[];
  /** Tool names the patterns are matched against. */
  declared: readonly string[];
  /** Names un-hidden earlier in this session (kept across resume). */
  loaded: readonly string[];
  /** Plan mode was on at session start. */
  planMode: boolean;
}

/** The hidden set, in `declared` order: pattern matches minus the floor, the loaded names and (in plan mode) the plan-mode tools. */
export function hiddenSet(input: HiddenInput): string[] {
  const keep = new Set<string>([...DEFERRED_FLOOR, ...input.loaded, ...(input.planMode ? PLAN_MODE_TOOLS : [])]);
  return input.declared.filter((name) => !keep.has(name) && input.patterns.some((p) => matchesPattern(p, name)));
}

/** The patterns that match none of `registered`: a typo or a package that is not installed (doctor). */
export function unmatchedPatterns(patterns: readonly string[], registered: readonly string[]): string[] {
  return patterns.filter((p) => !registered.some((name) => matchesPattern(p, name)));
}

/** Doctor WARN lines: a pattern that matches no registered tool, and the add-on's optional tools that `PI_BG_FEATURES=process` would not register at all. */
export function deferredDoctorLines(patterns: readonly string[], registered: readonly string[]): string[] {
  const out = unmatchedPatterns(patterns, registered).map((p) => `WARN tools.deferred pattern "${p}" matches no registered tool — fix: correct the name or remove it from tools.deferred (a package may not be installed)`);
  const optional = registered.filter((n) => n.startsWith("fusion_") || n === "bg_delegate" || n === "bg_run_pi_attested");
  if (optional.length) out.push(`WARN the background-tasks add-on registers ${optional.join(", ")}; disabled at the source they cost nothing, deferred they still cost their names in the prompt — fix: set PI_BG_FEATURES=process`);
  return out;
}

const names = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null);

/**
 * `tools.deferred` of the layers: `base` (defaults, overlay, user config) sets the list; the project or session value may only add
 * names. A value that is not a list of strings, or an empty list over a non-empty base (a removal), is dropped with a warning.
 */
export function mergeDeferredLayers(base: unknown, layers: readonly { who: string; value: unknown }[]): { list: string[]; warnings: string[] } {
  const list = [...(names(base) ?? [])];
  const warnings: string[] = [];
  for (const { who, value } of layers) {
    if (value === undefined) continue;
    const add = names(value);
    if (!add) warnings.push(`${who} tools.deferred ignored: not a list of tool names`);
    else if (add.length === 0 && list.length > 0) warnings.push(`${who} tools.deferred ignored: the ${who} may only add names, not remove them (user or overlay config sets the list)`);
    else for (const n of add) if (!list.includes(n)) list.push(n);
  }
  return { list, warnings };
}

/** The system-prompt hint: names only, so it stays small. With codemode a found tool is callable at once from a script. */
export function deferredHint(hidden: readonly string[], codemode: boolean): string {
  const how = codemode ? "search with `tool_search` before use; a found tool is callable at once from a codemode script as `tools.<name>()`" : "search with `tool_search` before use; a found tool is declared from the next request";
  return `Deferred tools, ${how}: ${hidden.join(", ")}`;
}
