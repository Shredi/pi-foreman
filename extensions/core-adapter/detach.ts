// Every child launch runs detached (design §5, §9): a foreground child runs ungated or has its
// permission asks auto-denied. pi-subagents 0.75.0 lets an explicit call value `async: false`
// beat the role frontmatter, and `foregroundOnly` skips `forceTopLevelAsync`, so the adapter
// rewrites the `subagent` call input in place before the guards run.
//
// Schema (pi-subagents 0.75.0, src/extension/schemas.js): top-level `async` (boolean);
// `foregroundOnly` is internal but is honoured when present; per-task arrays are `tasks[]`,
// `chain[]` and `chain[].parallel[]`. Their entries are strict ({agent, task, as?, parallel?}),
// so an entry only loses a forbidden value; nothing is added to it.

import { isActionCall } from "./actions.ts";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Rewrite one object; `addAsync` sets `async: true` when it is missing. True when something changed. */
function fix(o: Json, addAsync: boolean): boolean {
  let changed = false;
  if (o.async === false) {
    o.async = true;
    changed = true;
  } else if (addAsync && o.async === undefined) {
    o.async = true;
  }
  if ("foregroundOnly" in o) {
    if (o.foregroundOnly !== undefined && o.foregroundOnly !== false) changed = true;
    delete o.foregroundOnly;
  }
  return changed;
}

/**
 * Force a detached launch: top-level `async` becomes true when false or missing (management
 * calls with `action` only lose an explicit false), `foregroundOnly` is removed, and entries of
 * `tasks`, `chain` and `chain[].parallel` lose `async: false` / `foregroundOnly` the same way.
 * Returns true when a foreground request was overridden (an explicit false or foregroundOnly).
 */
export function forceDetached(input: Json): boolean {
  if (!isObj(input)) return false;
  // Action calls (allowlisted or checked in actions.ts) only lose an explicit false.
  const management = isActionCall(input);
  let overridden = fix(input, !management);
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isObj(entry)) continue;
      if (fix(entry, false)) overridden = true;
      visit(entry.parallel);
    }
  };
  visit(input.tasks);
  visit(input.chain);
  return overridden;
}
