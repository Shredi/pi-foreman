// Planner write scope and single-launch rule (plan-planner section A).
// A child whose launch binding names role `planner` may write only `.workflow/` and the scratch
// dir (the foreman's scratchpad rule, editmode.ts); the shell write guard applies to it too. The
// role is only known from the adapter-written launch binding, which exists for single launches,
// so `planner` is launched alone: not inside tasks/chain, never resumed.
import { actionOf, roundSteps } from "./actions.ts";
import type { RunRegistry } from "./actions.ts";
import { editModeBlock } from "./editmode.ts";
import { subagentAgents } from "./payload.ts";
import { singleLaunchRole } from "./usage.ts";

export const PLANNER_ROLE = "planner";

type Json = Record<string, unknown>;

/** True for a child session whose launch binding says role planner. */
export function isPlannerChild(isChild: boolean, role: string | undefined): boolean {
  return isChild && role === PLANNER_ROLE;
}

/** Refusal for a planner's file-tool call outside `.workflow/` and the scratch dir; undefined when it may go on. */
export function plannerWriteBlock(toolName: string, input: Json, scratchDir: string, opts: { cwd: string; home: string; platform: string }): string | undefined {
  const r = editModeBlock(toolName, input, "scratchpad", scratchDir, opts);
  if (!r) return undefined;
  const why = r.match(/\(([^()]*(?:disabled|hard-linked)[^()]*)\)\.$/)?.[1];
  const target = r.match(/ on '(.*)' refused/)?.[1];
  return `pi-foreman: ${toolName}${target ? ` on '${target}'` : ""} refused: ${PLANNER_SCOPE_NOTE(scratchDir)}${why ? ` (${why})` : ""}`;
}

export const PLANNER_SCOPE_NOTE = (scratchDir: string): string => `The planner writes only the plan under ${scratchDir} (and notes under .workflow/); report anything else back.`;

/** `pi-foreman: planner launch refused [launch_refused:planner_single]: ...`, or undefined. */
export function plannerLaunchBlock(input: Json, runs: RunRegistry): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const resume = actionOf(input) === "resume";
  const hit = resume ? roundSteps(input, runs).some((s) => s.includes(PLANNER_ROLE)) : subagentAgents(input).includes(PLANNER_ROLE) && singleLaunchRole(input) !== PLANNER_ROLE;
  if (!hit) return undefined;
  return `pi-foreman: planner launch refused [launch_refused:planner_single]: ${resume ? "a planner run cannot be resumed" : "planner cannot run inside tasks or chain"}; launch one planner with subagent({agent:"planner", task}).`;
}
