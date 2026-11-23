// Keeps the control inbox folders of an async run from ever being empty. pi-subagents creates
// <asyncDir>/control/steer-requests and /stop-requests when the runner starts and nothing removes them,
// but an empty folder in the temp root can be deleted by the OS (Windows Storage Sense), after which a
// steer or stop cannot be written. Its readers take only `*.json` files, so a `.keep` placeholder is
// never parsed as a request and never deleted.
import * as fs from "node:fs";
import * as path from "node:path";

export const INBOX_DIRS = ["steer-requests", "stop-requests"] as const;
export const INBOX_PLACEHOLDER = ".keep";

/** Creates both inbox folders under `asyncDir` and a placeholder in each. Best effort: returns the error text of the first failure, never throws. */
export function keepControlInboxes(asyncDir: string): string | null {
  let failure: string | null = null;
  for (const name of INBOX_DIRS) {
    try {
      const dir = path.join(asyncDir, "control", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, INBOX_PLACEHOLDER), "");
    } catch (e) {
      failure ??= e instanceof Error ? e.message : String(e);
    }
  }
  return failure;
}
