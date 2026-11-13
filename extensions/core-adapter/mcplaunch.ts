// Launch side of MCP on demand (round 68): the `mcp` field of `subagent`, top-level and per entry of `tasks`, `chain`
// and `chain[i].parallel` (also the object of a dynamic fan-out). The field names what one child gets, inside `roles.<role>.mcp` (absent or `[]` = nothing); it
// is validated against the entry's role, stripped before pi-subagents sees the call and carried in the launch binding.
// pi-subagents forwards `extensionBindings` to a child only on its single path, so a group launch that needs a binding
// is refused until a pinned pi-subagents forwards per-entry bindings (PER_ENTRY_BINDINGS).
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { allowedMcp, allowedMcpNamed, directMaxTools, inCeiling, roleMcpEntries, serverKey, splitEntry } from "./mcpscope.ts";
import { fromJsonText } from "./jsontext.ts";
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
  reason: "mcp_launch" | "mcp_group_gate" | "mcp_named_cap";
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

export const namedCapText = (count: number, cap: number): string =>
  `pi-foreman: launch mcp names ${count} tools as server/tool, over the cap of ${cap} (mcp.directMaxTools); a child gets named tools up front only up to the cap. Name fewer tools: the rest of a server named whole (mcp: ["server", "server/tool"]) is found with tool_search.`;

function checkList(raw: unknown, role: string, configRoles: unknown, cap: number): { list?: string[]; text?: string; reason?: McpRefusal["reason"] } {
  const value = fromJsonText(raw, "array");
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && splitEntry(x) !== null)) {
    return { text: "pi-foreman: launch mcp must be an array of non-empty strings, each `server` or `server/tool`" };
  }
  for (const entry of value as string[]) {
    if (!inCeiling(configRoles, role, entry.trim())) return { text: `pi-foreman: launch mcp entry ${entry.trim()} is outside roles.${role}.mcp` };
  }
  const list = (value as string[]).map((x) => x.trim());
  const tools = new Set(list.flatMap((x) => { const e = splitEntry(x); return e?.tool ? [`${serverKey(e.server)}/${e.tool}`] : []; }));
  if (tools.size > cap) return { text: namedCapText(tools.size, cap), reason: "mcp_named_cap" };
  return { list };
}

/**
 * Validate and strip the `mcp` fields of a `subagent` launch (the input is changed: the fields are removed). Management
 * calls (an `action`) are left alone. With `perEntryBindings` false, a group (`tasks`/`chain`) that needs a binding, that is
 * any entry that carries `mcp`, is refused; an entry without `mcp` gets no MCP and needs none.
 */
export function planMcpLaunch(input: Json, configRoles: unknown, opts: { perEntryBindings?: boolean; pinned?: string; maxTools?: unknown } = {}): McpPlan {
  const cap = directMaxTools(opts.maxTools);
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
    const checked = checkList(input.mcp, single, configRoles, cap);
    if (checked.text) return refuse(checked.reason ?? "mcp_launch", checked.text);
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
      const checked = checkList(entry.mcp, entry.agent, configRoles, cap);
      if (checked.text) return refuse(checked.reason ?? "mcp_launch", checked.text);
      entries.push({ entry, role: entry.agent, mcp: checked.list });
    }
  }
  if (group && !opts.perEntryBindings) {
    const needs = entries.some((e) => e.mcp !== undefined);
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

/** Servers of the role's ceiling (minus its denies) that `task` names as a whole word (or inside `mcp__server__tool`), in the `-` or the `_` form, any case. */
export function namedCeilingServers(configRoles: unknown, role: string, task: string): string[] {
  const ceiling = allowedMcp(configRoles, role, roleMcpEntries(configRoles, role));
  return [...ceiling.servers, ...Object.keys(ceiling.tools)].filter((server) => {
    const name = server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_]/g, "[-_]");
    // also right after `mcp__` (a tool name `mcp__server__tool`); `server_x` and `server-x` stay other words
    return new RegExp(`(?:(?<![A-Za-z0-9_-])|(?<=mcp__))${name}(?![A-Za-z0-9-])(?!_[A-Za-z0-9])`, "i").test(task);
  });
}

export const mcpHintLine = (role: string, servers: string[]): string =>
  `pi-foreman: the task names MCP server ${servers.join(", ")} (roles.${role}.mcp) but the launch has no mcp field, so the child runs without MCP; pass mcp: [${servers.map((s) => JSON.stringify(s)).join(", ")}] to give it that server.`;

/** Servers a launch names whole and names no tool of (the child's tools of them are declared up front only if they fit under the cap). */
export function wholeOnlyServers(configRoles: unknown, role: string, launchMcp: string[] | undefined): string[] {
  const allowed = allowedMcpNamed(configRoles, role, launchMcp);
  const named = new Set(Object.keys(allowed.named ?? {}).map(serverKey));
  return allowed.servers.filter((s) => !named.has(serverKey(s)));
}

export const wholeServerLine = (role: string, servers: string[], cap: number): string =>
  `pi-foreman: the launch names MCP server ${servers.join(", ")} (role ${role}) without a tool of it. Over the cap of ${cap} (mcp.directMaxTools) nothing of it is declared up front and the child finds the tools with tool_search; to have tools in its list from the first request, name them: mcp: [${servers.map((s) => JSON.stringify(s)).join(", ")}, ${JSON.stringify(`${servers[0]}/<tool>`)}].`;

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
