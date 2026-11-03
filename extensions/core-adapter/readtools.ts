// `gate.readTools`: extension tools (ffgrep, fffind, ...) the gate judges like read/grep on their path field.
// The map comes from the merged config (user or overlay layer only; the project layer's gate keys are dropped by foreman_config.py).
import { get } from "./config.ts";
import type { ReadToolMap } from "./rules.ts";

/** The valid entries of `gate.readTools`: a non-empty tool name mapped to a non-empty path field name, or null (no path field: the tool reads the cwd). Anything else is ignored. */
export function readToolsOf(config: unknown): ReadToolMap | undefined {
  const v = get(config, "gate.readTools");
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [name, field] of Object.entries(v)) {
    if (name && (field === null || (typeof field === "string" && field))) out[name] = field as string | null;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Names in the map that no registered tool carries (a pi-fff `override` mode registers grep/find/multi_grep, not ffgrep/fffind). */
export function unknownReadTools(map: ReadToolMap | undefined, known: Iterable<string>): string[] {
  if (!map) return [];
  const have = new Set(known);
  return Object.keys(map).filter((n) => !have.has(n));
}

/** Warn once per name through `emit` (a trace record); never throws. */
export function warnUnknownReadTools(map: ReadToolMap | undefined, allToolNames: () => Iterable<string>, warned: Set<string>, emit: (rec: Record<string, string>) => void): void {
  try {
    const names = unknownReadTools(map, allToolNames()).filter((n) => !warned.has(n));
    for (const n of names) warned.add(n);
    if (names.length) emit({ event: "config_warning", reason: "gate.readTools names no registered tool", names: names.join(",") });
  } catch {
    // a failed tool listing is no reason to fail a gate call
  }
}
