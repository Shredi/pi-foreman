// The launch keyword `top` (launchmodel.ts TOP_KEYWORD) is the steward's: one read-only explorer on the highest-ranked
// model of the role map. Every other use is refused, so the cost of the strongest model cannot grow elsewhere.
import { TOP_KEYWORD, splitLevel } from "./launchmodel.ts";

type Json = Record<string, unknown>;

const has = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** The entries (of `launchEntries`) whose model is the keyword `top`, the launch's own `model` counting for entries without one. */
export function topEntries(entries: Json[], input: Json): Json[] {
  return entries.filter((e) => {
    const m = e.model ?? input.model;
    return typeof m === "string" && splitLevel(m.trim()).base === TOP_KEYWORD;
  });
}

/** One refusal line for a launch that misuses `top`, or null: allowed only for `explorer`, in the steward session, with a `reason`. */
export function topRefusal(entries: Json[], input: Json, steward: boolean): string | null {
  const top = topEntries(entries, input);
  if (top.length === 0) return null;
  if (!steward) return `pi-foreman: launch refused [top_not_allowed]: model "top" is for the steward session only.`;
  if (top.some((e) => e.agent !== "explorer")) return `pi-foreman: launch refused [top_not_allowed]: model "top" is for the explorer role only.`;
  if (top.some((e) => !has(e.reason) && !has(input.reason))) return `pi-foreman: launch refused [top_not_allowed]: model "top" needs a reason.`;
  return null;
}
