// The top-level foreman's tool floor: another extension's tool reset (a plan-mode exit that writes a `tools` record) is re-folded by Pi on
// every resume and would leave these tools inactive for good. Pure function, no Pi imports.
import { DEFERRED_FLOOR } from "./deferred.ts";

/** Deferred-floor tools the owner may switch off on purpose (search, codemode, the file tools, the ask tool); the floor leaves them alone. */
const OWNER_CHOICE: readonly string[] = ["tool_search", "codemode", "read", "bash", "ask_user_question"];

/** The tools a top-level foreman needs active: the routing part of the deferred floor plus the session, wait, checkpoint and background tools and intercom. */
export const TOOL_FLOOR: readonly string[] = [...DEFERRED_FLOOR.filter((n) => !OWNER_CHOICE.includes(n)), "foreman_session_open", "foreman_wait", "foreman_checkpoint", "foreman_bg", "intercom"];

export interface FloorInput {
  /** Names of every registered tool. */
  all: readonly string[];
  /** Names of the active tools. */
  active: readonly string[];
  isChild: boolean;
  /** Plan mode is on: its own tool set stays in force. */
  planMode: boolean;
}

/** The registered but inactive floor tools, in floor order. A child and a plan-mode session get none. */
export function missingFloorTools(input: FloorInput): string[] {
  if (input.isChild || input.planMode) return [];
  const registered = new Set(input.all);
  const active = new Set(input.active);
  return TOOL_FLOOR.filter((name) => registered.has(name) && !active.has(name));
}
