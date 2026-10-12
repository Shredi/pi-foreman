// Self-planning (ceremony.planner): who writes the heavy plan.
//
// "self" (default): the foreman writes `.workflow/scratch/plan-<topic>.md` itself; the heavy planner
// step is satisfied by its approved checkpoint, no planner launch is required. "role": a planner
// launch is required, except that a planner on the foreman's own rung (or above it) switches the
// session to self at the launch attempt, so a session is never left without a plan path.
import { get, type Json } from "./config.ts";
import type { Step } from "./bound.ts";
import type { PlanRecord } from "./checkpoint.ts";
import { ranksOf, tierOf } from "./ranks.ts";

export type PlannerMode = "self" | "role";

/** ceremony.planner: "role" only when set so, else "self". */
export function plannerMode(config: Json | undefined): PlannerMode {
  return get(config, "ceremony.planner") === "role" ? "role" : "self";
}

/** The mode in force: the session's fallback to self wins over a configured "role". */
export function effectivePlannerMode(config: Json | undefined, fellBack: boolean): PlannerMode {
  return fellBack ? "self" : plannerMode(config);
}

/** The required steps without `planner` when the mode is self and the session holds an approved plan record. */
export function selfPlanRequired(steps: Step[], mode: PlannerMode, plan: PlanRecord | null | undefined): Step[] {
  return mode === "self" && plan?.status === "approved" ? steps.filter((s) => s !== "planner") : steps;
}

/**
 * True when the planner model does not sit strictly below the foreman's (tier number <= the foreman's,
 * compared directly whatever ladder.childPolicy says). An unranked planner or foreman model counts as
 * "not below"; with no ranks configured anywhere the check is inert (nothing is ranked).
 */
export function plannerNotBelow(config: Json | undefined, foremanModel: string | null, plannerModel: string): boolean {
  const ranks = ranksOf(config);
  if (ranks.size === 0) return false;
  const f = foremanModel ? tierOf(ranks, foremanModel) : null;
  const p = tierOf(ranks, plannerModel);
  return f === null || p === null || p <= f;
}

export const PLANNER_SELF_MESSAGE = "pi-foreman: planner sits on your own rung: plan it yourself in .workflow/scratch/plan-<topic>.md; the planner step is satisfied by your approved plan.";
