// The knowledge-source nudge (`foreman knowledge`, docs/sessions.md): one line when the last source check is older than `knowledge.nudgeDays` or never ran.
// The rule lives in scripts/foreman_knowledge.mjs (shared with the shell `nudge` subcommand); this wrapper only fixes the types.
import { knowledgeNudge as nudge } from "../../scripts/foreman_knowledge.mjs";

/** The one-line nudge, or null when the last check is recent. */
export function knowledgeNudge(agentDir: string, nudgeDays: number, now: Date | number = Date.now()): string | null {
  return nudge(agentDir, nudgeDays, now) as string | null;
}

/** `text` with the nudge appended on its own line (unchanged when there is none). */
export function withNudge(text: string, agentDir: string, nudgeDays: unknown, now: Date | number = Date.now()): string {
  const days = typeof nudgeDays === "number" && Number.isFinite(nudgeDays) && nudgeDays >= 0 ? nudgeDays : 30;
  const line = knowledgeNudge(agentDir, days, now);
  return line ? `${text}\n${line}` : text;
}
