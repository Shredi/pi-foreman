// R41 gate dialog (plan 2.5): the texts of the owner-pane dialog and of the child / headless denials, and the round-session ask
// file (`ask.md` in the handoff dir, answered by the parent with `ruling-<n>.md`). No model is involved in any of it.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAskHeader } from "./askcontract.ts";
import { isRulingName } from "./ruling.ts";

export const DIALOG_OPTIONS = ["allow once", "allow for session", "deny with reason", "deny and stop"] as const;
export type DialogOption = (typeof DIALOG_OPTIONS)[number];
export const DEFAULT_ASK_TIMEOUT_MS = 15 * 60 * 1000;
const PAYLOAD_CAP = 600;

/** Why the dialog opens: the policy asks (entry + reason), or the review could not decide (cause + detail). */
export type GateAsk = { cause: "ask"; entry: string; reason: string } | { cause: "unreachable"; why: string; detail: string };

const UNREACHABLE_NAMES: Record<string, string> = { timeout: "timeout", provider_error: "provider error", no_model: "no model configured", invalid_verdict: "invalid verdict" };
export const unreachableName = (cause: string): string => UNREACHABLE_NAMES[cause] ?? cause;

export const cut = (text: string, max = PAYLOAD_CAP): string => (text.length > max ? `${text.slice(0, max)} ... [${text.length - max} more chars]` : text);

export function dialogTitle(a: GateAsk): string {
  return a.cause === "ask" ? `pi-foreman: policy asks (${a.entry})` : `pi-foreman: review unreachable (${unreachableName(a.why)})`;
}

/** The dialog body: tool, payload, cause detail. The select title carries all of it (Pi's select has one text field). */
export function dialogBody(a: GateAsk, tool: string, payload: string): string {
  const why = a.cause === "ask" ? `entry ${a.entry}: ${a.reason}` : `${unreachableName(a.why)}: ${a.detail}`;
  return `${dialogTitle(a)}\n${tool}: ${cut(payload)}\n${why}`;
}

/** The deny text for a session that cannot be asked (child, headless, owner without a UI). */
export function silentDeny(kind: "child" | "headless", a: GateAsk): string {
  if (a.cause === "ask") {
    return kind === "child"
      ? `pi-foreman: policy ask ${a.entry}: ${a.reason}. Children cannot answer asks; report this line to the foreman and continue with what you can.`
      : `pi-foreman: policy ask ${a.entry}: ${a.reason}. This session cannot answer asks; the call is denied. Report this to the owner.`;
  }
  return `pi-foreman: the permission review is unreachable (${unreachableName(a.why)}: ${a.detail}); the call is denied. Report this to the owner.`;
}

export const userDeny = (typed: string): string => (typed.trim() ? `pi-foreman: denied by the user: ${typed.trim()}` : "pi-foreman: denied by the user.");
export const STOP_TEXT = "pi-foreman: denied by the user, who asked you to stop. Do not retry or work around this; stop and ask the owner what to do next.";

/** The next free ask number of a handoff dir: above every `# Ask <n>` header and every `ruling-<n>.md` present. */
export function nextAskN(dir: string): number {
  let n = 0;
  try {
    n = Math.max(n, parseAskHeader(fs.readFileSync(path.join(dir, "ask.md"), "utf8"))?.n ?? 0);
  } catch {
    // no ask yet
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = isRulingName(f) ? /^ruling-(\d+)\.md$/.exec(f) : null;
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    // unreadable dir: n stays
  }
  return n + 1;
}

export interface RoundAsk {
  tool: string;
  payload: string;
  cwd: string;
  session: string;
}

/** Write `<dir>/ask.md` (header `# Ask <n>: <topic>`, then `key: value` lines and the payload) and return n. */
export function writeRoundAsk(dir: string, a: GateAsk, f: RoundAsk): number {
  const n = nextAskN(dir);
  const detail = a.cause === "ask" ? [`cause: policy ask`, `entry: ${a.entry}`, `reason: ${a.reason}`] : [`cause: review unreachable`, `unreachable: ${unreachableName(a.why)}`, `detail: ${a.detail}`];
  const text = [`# Ask ${n}: gate ${a.cause === "ask" ? "ask" : "review unreachable"} for ${f.tool}`, "", ...detail, `tool: ${f.tool}`, `cwd: ${f.cwd}`, `session: ${f.session}`, "", "Answer with ruling-" + n + ".md whose first line is ALLOW or DENY (anything else denies).", "", "```", cut(f.payload, 4000), "```", ""].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.ask.md.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, path.join(dir, "ask.md"));
  return n;
}

export type RulingAnswer = { answer: "allow" | "deny" | "other" | "timeout"; first?: string };

/** Poll `<dir>/ruling-<n>.md` until it exists or `timeoutMs` passes; its first line ALLOW / DENY (case-insensitive) decides. */
export async function awaitRuling(dir: string, n: number, timeoutMs: number, pollMs = 250): Promise<RulingAnswer> {
  const file = path.join(dir, `ruling-${n}.md`);
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const first = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0].trim();
      if (first) {
        const w = first.toLowerCase();
        return { answer: w === "allow" ? "allow" : w === "deny" ? "deny" : "other", first };
      }
    } catch {
      // not there yet
    }
    const left = end - Date.now();
    if (left <= 0) return { answer: "timeout" };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
  }
}
