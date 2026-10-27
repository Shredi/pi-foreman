// Launch side of MCP on demand (round 68): the `mcp` field of `subagent`, top-level and per entry of `tasks`, `chain`
// and `chain[i].parallel` (also the object of a dynamic fan-out). The field narrows `roles.<role>.mcp` for one child; it
// is validated against the entry's role, stripped before pi-subagents sees the call and carried in the launch binding.
// pi-subagents forwards `extensionBindings` to a child only on its single path, so a group launch that needs a binding
// is refused until a pinned pi-subagents forwards per-entry bindings (PER_ENTRY_BINDINGS).
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { allowedMcp, inCeiling, roleMcpEntries, serverKey, splitEntry } from "./mcpscope.ts";
import { groupEntryObjects, singleLaunchRole } from "./usage.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Capability `subagents.perEntryBindings`: true once the pinned pi-subagents forwards `extensionBindings` of group entries to their children. */
export const PER_ENTRY_BINDINGS = false;

/** Version of the pi-subagents this package resolves (the pin), "unknown" when unreadable. */
export function pinnedSubagentsVersion(): string {
  try {
    const entry = createRequire(import.meta.url).resolve("pi-subagents");
    let dir = path.dirname(entry);
    for (let i = 0; i < 4; i++) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "pi-subagents" && typeof pkg.version === "string") return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return "unknown";
}

export const groupGateText = (version: string): string =>
  `pi-foreman: group launches with MCP need pi-subagents with per-entry bindings (pinned ${version}); launch these roles as single subagent({agent, task}) calls`;

export interface McpRefusal {
  /** The `launch_refused` reason. */
  reason: "mcp_launch" | "mcp_group_gate";
  text: string;
}

export interface McpEntry {
  entry: Json;
  role: string;
  /** The validated launch `mcp` list; undefined = the field was absent. */
  mcp?: string[];
}

export interface McpPlan {
  refusal?: McpRefusal;
  /** Single launch: its validated `mcp` list. */
  mcp?: string[];
  /** Every entry with a role: the call itself for a single launch, else the group's entries. */
  entries: McpEntry[];
  group: boolean;
}

const refuse = (reason: McpRefusal["reason"], text: string): McpPlan => ({ refusal: { reason, text }, entries: [], group: false });

function checkList(value: unknown, role: string, configRoles: unknown): { list?: string[]; text?: string } {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && splitEntry(x) !== null)) {
    return { text: "pi-foreman: launch mcp must be an array of non-empty strings, each `server` or `server/tool`" };
  }
  for (const entry of value as string[]) {
    if (!inCeiling(configRoles, role, entry.trim())) return { text: `pi-foreman: launch mcp entry ${entry.trim()} is outside roles.${role}.mcp` };
  }
  return { list: (value as string[]).map((x) => x.trim()) };
}

/**
 * Validate and strip the `mcp` fields of a `subagent` launch (the input is changed: the fields are removed). Management
 * calls (an `action`) are left alone. With `perEntryBindings` false, a group (`tasks`/`chain`) that needs a binding, that is
 * any entry whose role has a non-empty ceiling or that carries `mcp`, is refused.
 */
export function planMcpLaunch(input: Json, configRoles: unknown, opts: { perEntryBindings?: boolean; pinned?: string } = {}): McpPlan {
  if (!isObj(input) || input.action !== undefined) return { entries: [], group: false };
  if (isObj(input.options) && "mcp" in input.options) {
    return refuse("mcp_launch", "pi-foreman: options.mcp is not a launch option; pass mcp as a field of subagent({agent, task, mcp}) or of a tasks/chain entry");
  }
  const single = singleLaunchRole(input);
  const group = Array.isArray(input.tasks) || Array.isArray(input.chain);
  const entries: McpEntry[] = [];
  let top: string[] | undefined;
  if (input.mcp !== undefined) {
    if (!single) return refuse("mcp_launch", "pi-foreman: launch mcp goes on subagent({agent, task, mcp}) or on a tasks/chain entry; this call has no single agent");
    const checked = checkList(input.mcp, single, configRoles);
    if (checked.text) return refuse("mcp_launch", checked.text);
    top = checked.list;
  }
  if (single) entries.push({ entry: input, role: single, ...(top ? { mcp: top } : {}) });
  else if (group) {
    for (const entry of groupEntryObjects(input)) {
      if (entry.mcp === undefined) {
        if (typeof entry.agent === "string" && entry.agent) entries.push({ entry, role: entry.agent });
        continue;
      }
      if (typeof entry.agent !== "string" || !entry.agent) return refuse("mcp_launch", "pi-foreman: a tasks/chain entry with mcp needs an agent; the list is checked against that role's ceiling");
      const checked = checkList(entry.mcp, entry.agent, configRoles);
      if (checked.text) return refuse("mcp_launch", checked.text);
      entries.push({ entry, role: entry.agent, mcp: checked.list });
    }
  }
  if (group && !opts.perEntryBindings) {
    const needs = entries.some((e) => e.mcp !== undefined || roleMcpEntries(configRoles, e.role).length > 0);
    if (needs) return refuse("mcp_group_gate", groupGateText(opts.pinned ?? pinnedSubagentsVersion()));
  }
  delete input.mcp;
  if (group) for (const e of entries) delete e.entry.mcp;
  return { ...(top ? { mcp: top } : {}), entries, group };
}

/** Server names an entry's allowed set names that Pi's loaded config (`configured`) does not know. */
export function unknownServers(configRoles: unknown, role: string, launchMcp: string[] | undefined, configured: readonly string[]): string[] {
  const allowed = allowedMcp(configRoles, role, launchMcp);
  // the role's own entries count too, also when a deny emptied them: the owner named a server that does not exist
  const named = [...allowed.servers, ...Object.keys(allowed.tools), ...roleMcpEntries(configRoles, role).map((e) => splitEntry(e)?.server ?? "")].filter(Boolean);
  const known = new Set(configured.map(serverKey));
  return [...new Set(named.filter((n) => !known.has(serverKey(n))))];
}

export const unknownServerLine = (role: string, servers: string[]): string =>
  `pi-foreman: MCP server ${servers.join(", ")} (role ${role}) is not in Pi's mcp.json (global file, or the project file when trusted); the child cannot load it.`;

// ---------------------------------------------------------------- workflow scripts (A22)

const BINDING_WORDS = /extensionBindings|pi-foreman\/1/;
const MAX_SCRIPT_BYTES = 1_000_000;

/**
 * With `safety.subagents.allowWorkflow` on, a workflow script could pass `extensionBindings` per child and forge a
 * `pi-foreman/1` binding (any role, any `mcp`). A script whose text (the reply's text for `workflow: true`, the file for a
 * path, `workflowScript`, and the JSON `args`) names either word is refused, so only adapter-written bindings exist.
 */
export function workflowBindingBlock(input: Json, ctx: { cwd: string; replyText: string; roles?: unknown }): string | undefined {
  if (!isObj(input) || (input.workflow === undefined && input.workflowScript === undefined)) return undefined;
  const texts: string[] = [];
  // pi-subagents reads the string "true" as true and takes a slash or a backslash as a script path
  const workflow = input.workflow === "true" ? true : input.workflow;
  if (workflow === true) texts.push(ctx.replyText);
  const ceiling = isObj(ctx.roles) && Object.keys(ctx.roles).some((r) => roleMcpEntries(ctx.roles, r).length > 0);
  if (typeof workflow === "string" && workflow.trim() && !workflow.includes("/") && !workflow.includes("\\")) {
    if (ceiling) return namedResourceText();
  }
  if (typeof workflow === "string" && (workflow.includes("/") || workflow.includes("\\"))) {
    try {
      // pi-subagents resolves the script against the launch's own cwd
      const file = path.resolve(ctx.cwd, typeof input.cwd === "string" && input.cwd ? input.cwd : ".", workflow);
      if (fs.statSync(file).size <= MAX_SCRIPT_BYTES) texts.push(fs.readFileSync(file, "utf8"));
      else return refusalText();
    } catch {
      // an unreadable script cannot be inspected: refused while a role has an MCP ceiling, else pi-subagents fails the launch itself
      if (ceiling) return unreadableScriptText();
    }
  }
  if (typeof input.workflowScript === "string") texts.push(input.workflowScript);
  if (input.args !== undefined) {
    try {
      texts.push(JSON.stringify(input.args));
    } catch {
      return refusalText();
    }
  }
  return texts.some((t) => BINDING_WORDS.test(t)) ? refusalText() : undefined;
}

const namedResourceText = (): string =>
  "pi-foreman: subagent launch refused [launch_refused:workflow_binding]: named workflow resources cannot be checked for a forged launch binding while a role has an MCP ceiling (roles.<role>.mcp); use workflow: true or a script path instead.";

const unreadableScriptText = (): string =>
  "pi-foreman: subagent launch refused [launch_refused:workflow_binding]: the workflow script cannot be read from the launch cwd, so it cannot be checked for a forged launch binding while a role has an MCP ceiling (roles.<role>.mcp).";

const refusalText = (): string =>
  "pi-foreman: subagent launch refused [launch_refused:workflow_binding]: a workflow script that names `extensionBindings` or `pi-foreman/1` could forge a launch binding; only the adapter writes bindings. Remove it from the script.";
