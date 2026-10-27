// Doctor lines for the gate config migration (R41 item 12): leftover permission-package keys, rendered config or install.
// The texts come from scripts/foreman_migrate_gate.mjs, so the doctor and `foreman setup` print the same words.
import { gateLeftovers, SETTINGS_COMMAND } from "../../scripts/foreman_migrate_gate.mjs";

export const GATE_MIGRATION_FIX = "run foreman setup (it migrates the keys, backs up and removes the rendered config)";
export const GATE_SETTINGS_FIX = `run ${SETTINGS_COMMAND} --dry-run, then ${SETTINGS_COMMAND} (backs up settings.json, drops the package entry)`;

/** One FAIL line per leftover; empty when the migration is complete. */
export function gateMigrationLines(i: { agentDir: string; config: unknown }): string[] {
  return (gateLeftovers(i) as string[]).map((t) => `FAIL ${t} — fix: ${t.startsWith("permission package entry") ? GATE_SETTINGS_FIX : GATE_MIGRATION_FIX}`);
}
