// Subagent management actions (design §9, plan D6): a fail-closed allowlist.
//
// pi-subagents 0.75.0 (src/shared/types.js SUBAGENT_ACTIONS) runs a `subagent` call with a
// non-empty `action` in management mode. Some actions start children or Pi sessions outside the
// role allowlist and the role map, so only the actions classified "manage" below pass unchecked.
// `resume` passes only for a run this session launched whose role and mapped model still hold.
// `schedule.*` and the `workflow` parameter (a script can name any agent) are blocked unless
// `safety.subagents.allowWorkflow` is true; `append-step` (removed upstream) and every unknown
// action are blocked. pi-subagents trims the action before dispatch; so does `actionOf`.
import { launchModel, splitLevel } from "./launchmodel.ts";
import type { RoleResolution } from "./roles.ts";

type Json = Record<string, unknown>;

export type ActionClass = "manage" | "resume" | "workflow" | "block";

/** Every SUBAGENT_ACTIONS value of pi-subagents 0.75.0, classified. */
export const ACTION_TABLE: Readonly<Record<string, { cls: ActionClass; why: string }>> = Object.freeze({
  list: { cls: "manage", why: "lists agents" },
  get: { cls: "manage", why: "reads one agent definition" },
  models: { cls: "manage", why: "lists models" },
  "children.list": { cls: "manage", why: "lists children" },
  guide: { cls: "manage", why: "reads the guide" },
  validate: { cls: "manage", why: "validates without running (a workflow parameter is still blocked)" },
  create: { cls: "block", why: "writes an agent definition (could redefine a role's tools or model)" },
  update: { cls: "block", why: "writes an agent definition" },
  delete: { cls: "block", why: "deletes an agent definition" },
  eject: { cls: "block", why: "copies a builtin agent into an editable definition" },
  disable: { cls: "block", why: "changes the agent set" },
  enable: { cls: "block", why: "changes the agent set (can re-enable builtins)" },
  reset: { cls: "block", why: "rewrites an agent definition" },
  "mission.create": { cls: "manage", why: "mission record only" },
  "mission.list": { cls: "manage", why: "mission record only" },
  "mission.show": { cls: "manage", why: "mission record only" },
  "mission.update": { cls: "manage", why: "mission record only" },
  "mission.resolve-decision": { cls: "manage", why: "mission record only" },
  "mission.attach-run": { cls: "manage", why: "mission record only" },
  "mission.close": { cls: "manage", why: "mission record only" },
  "worktree.discard": { cls: "block", why: "deletes a worktree (use foreman_worktree_remove)" },
  "worktree.cleanup": { cls: "manage", why: "plan only, removes nothing" },
  "lane.status": { cls: "manage", why: "reads a lane manifest" },
  "lane.recordMerge": { cls: "manage", why: "records merge evidence" },
  "lane.recordSupersession": { cls: "manage", why: "records supersession evidence" },
  refine: { cls: "block", why: "launches a foreground reviewer child outside the role map" },
  "refine.show": { cls: "manage", why: "reads a refinement" },
  "refine.rollback": { cls: "block", why: "rewrites an agent definition" },
  "inspector.open": { cls: "block", why: "starts an inspector process" },
  "inspector.command": { cls: "manage", why: "prints a command, runs nothing" },
  "inspector.status": { cls: "manage", why: "reads inspector state" },
  "inspector.close": { cls: "manage", why: "closes an inspector" },
  "project.open": { cls: "block", why: "starts a Pi session in a new pane outside the role map" },
  "project.status": { cls: "manage", why: "reads pane state" },
  "project.close": { cls: "manage", why: "closes a pane" },
  status: { cls: "manage", why: "reads run status" },
  "debug.run": { cls: "manage", why: "reads run status" },
  "grant-spawn-budget": { cls: "manage", why: "needs the user's own confirmation upstream" },
  interrupt: { cls: "manage", why: "pauses a running child" },
  resume: { cls: "resume", why: "starts a child from a stored session: provenance, role and model checked" },
  steer: { cls: "manage", why: "sends a message to a running child" },
  stop: { cls: "manage", why: "stops a child" },
  "command.status": { cls: "manage", why: "reads a command" },
  "command.yield": { cls: "manage", why: "lets a running command continue in the background" },
  "command.cancel": { cls: "manage", why: "cancels a command" },
  dismiss: { cls: "manage", why: "dismisses a finished run" },
  doctor: { cls: "manage", why: "diagnostics" },
  "watchdog.status": { cls: "manage", why: "reads watchdog state" },
  "watchdog.check": { cls: "manage", why: "reads watchdog state" },
  "watchdog.configure": { cls: "block", why: "picks a watchdog model and can write settings files" },
  "watchdog.recommend-model": { cls: "manage", why: "reads a recommendation" },
  "schedule.create": { cls: "workflow", why: "schedules a launch that can name any agent" },
  "schedule.list": { cls: "workflow", why: "schedule.* is blocked as a group" },
  "schedule.show": { cls: "workflow", why: "schedule.* is blocked as a group" },
  "schedule.history": { cls: "workflow", why: "schedule.* is blocked as a group" },
  "schedule.pause": { cls: "workflow", why: "schedule.* is blocked as a group" },
  "schedule.resume": { cls: "workflow", why: "starts scheduled launches again" },
  "schedule.run": { cls: "workflow", why: "runs a scheduled launch now" },
  "schedule.run-due": { cls: "workflow", why: "runs due scheduled launches" },
  "schedule.delete": { cls: "workflow", why: "schedule.* is blocked as a group" },
});

/** The trimmed action, or null for an execution call (absent or blank, as pi-subagents reads it). */
export function actionOf(input: Json): string | null {
  if (!input || typeof input !== "object") return null;
  const a = input.action;
  if (a === undefined || a === null) return null;
  if (typeof a !== "string") return String(a);
  const t = a.trim();
  return t === "" ? null : t;
}

/** True for a call with an allowlisted non-launching action (no role or model check applies). */
export function isManagementCall(input: Json): boolean {
  const a = actionOf(input);
  return a !== null && Object.prototype.hasOwnProperty.call(ACTION_TABLE, a) && ACTION_TABLE[a].cls === "manage";
}

/** True for any call with an action (management mode upstream). */
export function isActionCall(input: Json): boolean {
  return actionOf(input) !== null;
}

export function classifyAction(action: string): ActionClass {
  if (Object.prototype.hasOwnProperty.call(ACTION_TABLE, action)) return ACTION_TABLE[action].cls;
  if (action.startsWith("schedule.")) return "workflow";
  return "block";
}

/** What this session launched: run id -> role and the model the adapter wrote into the launch. */
export interface LaunchedRun {
  role: string;
  /** Base model id (`<provider>/<model>`, level dropped), or null when it was not known. */
  model: string | null;
}
export type RunRegistry = Map<string, LaunchedRun>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Record a run id from a `subagent` tool_result. pi-subagents returns `details.runId`
 * (also `asyncId`) for a launch and for a resume. Only single-agent launches are recorded
 * (`agent`, no `tasks`/`chain`); a resume inherits the record of the run it resumed.
 */
export function recordLaunch(runs: RunRegistry, input: unknown, details: unknown, isError: boolean): void {
  if (isError || !isObj(input) || !isObj(details)) return;
  const id = typeof details.runId === "string" && details.runId ? details.runId : typeof details.asyncId === "string" && details.asyncId ? details.asyncId : null;
  if (!id) return;
  const action = actionOf(input);
  if (action === "resume") {
    const prev = runs.get(resumeTarget(input) ?? "");
    if (prev) runs.set(id, { ...prev });
    return;
  }
  if (action !== null) return;
  if (Array.isArray(input.tasks) || Array.isArray(input.chain) || input.workflow !== undefined) return;
  if (typeof input.agent !== "string" || input.agent === "") return;
  const model = typeof input.model === "string" && input.model ? splitLevel(input.model).base : null;
  runs.set(id, { role: input.agent, model });
}

function resumeTarget(input: Json): string | null {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (id && runId && id !== runId) return null;
  return id || runId || null;
}

export interface ActionContext {
  allowWorkflow: boolean;
  runs: RunRegistry;
  /** Child role ids allowed now (merged config). */
  allowed: readonly string[];
  resolution: RoleResolution;
  maxThinking: unknown;
}

/** Result of the action check: a block reason, or a pass (with a note when a loosening key let it through). */
export interface ActionDecision {
  block?: string;
  /** Set when `allowWorkflow` let a workflow/schedule call through unchecked. */
  unchecked?: string;
}

/**
 * Check a `subagent` call's action and workflow parameters. Execution calls without a
 * workflow parameter pass here (the role and model checks handle them).
 */
export function subagentActionCheck(input: Json, c: ActionContext): ActionDecision {
  if (!isObj(input)) return {};
  const action = actionOf(input);
  const workflow = input.workflow !== undefined || input.workflowScript !== undefined;
  if (workflow) {
    if (!c.allowWorkflow) return { block: "pi-foreman: workflow scripts can launch any agent with any model, outside the role allowlist and the role map; the call is blocked. Launch roles directly with subagent({agent, task}). (safety.subagents.allowWorkflow enables it in the user or overlay config.)" };
    return { unchecked: "workflow" };
  }
  if (action === null) return {};
  const cls = classifyAction(action);
  if (cls === "manage") return {};
  if (cls === "workflow") {
    if (!c.allowWorkflow) return { block: `pi-foreman: subagent action '${action}' is blocked: schedules can launch any agent outside the role allowlist and the role map. Launch roles directly. (safety.subagents.allowWorkflow enables it in the user or overlay config.)` };
    return { unchecked: action };
  }
  if (cls === "block") {
    if (action === "append-step") return { block: "pi-foreman: subagent action 'append-step' is refused (removed upstream; it would add a step outside the role checks). Launch a fresh role instead." };
    const known = Object.prototype.hasOwnProperty.call(ACTION_TABLE, action);
    return { block: `pi-foreman: subagent action '${action}' is ${known ? `not allowed (${ACTION_TABLE[action].why})` : "unknown to pi-foreman and blocked"}.` };
  }
  return resumeCheck(input, c);
}

function resumeCheck(input: Json, c: ActionContext): ActionDecision {
  const target = resumeTarget(input);
  const known = target ? c.runs.get(target) : undefined;
  const fresh = (role: string | undefined, why: string): ActionDecision => ({
    block: `pi-foreman: resume blocked: ${why}; launch a fresh ${role ?? "<role>"} instead.`,
  });
  if (input.dir !== undefined) return fresh(known?.role, "resume by async directory is not checked");
  if (Array.isArray(input.chain) || Array.isArray(input.tasks)) return fresh(known?.role, "resume with an attached chain is not checked");
  if (!target) return fresh(undefined, "no single run id (id/runId missing or different)");
  if (!known) return fresh(undefined, `run '${target}' was not launched by this session`);
  if (!c.allowed.includes(known.role)) return fresh(undefined, `role '${known.role}' of run '${target}' is no longer an allowed role`);
  if (known.model === null) return fresh(known.role, `the model of run '${target}' is not known`);
  if (c.resolution.source !== "cli" || !c.resolution.provider) return fresh(known.role, "the role map is not resolved for an active provider");
  const now = launchModel(known.role, c.resolution.roles, undefined, c.maxThinking);
  if (!now) return fresh(known.role, `role '${known.role}' has no model for provider '${c.resolution.provider}'`);
  const mapped = splitLevel(now.model).base;
  if (mapped !== known.model) return fresh(known.role, `run '${target}' ran on ${known.model}, the role map now gives ${mapped}`);
  return {};
}
