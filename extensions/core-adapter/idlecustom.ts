// Custom messages appended while the foreman is idle (ledger 11).
//
// pi-subagents 0.76.1+ (src/shared/parent-wake.js) wakes an idle parent in two steps: it appends
// the notice or supervisor request with `pi.sendMessage(msg, { triggerTurn: false })`, then starts
// the run with `pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" })`. Pi appends an idle
// `triggerTurn: false` message to the session without an extension `message_end` (agent-session.js
// _appendCustomMessage emits to session listeners only), so the adapter never saw those messages:
// no supervisor window, no completion-notice bookkeeping, no `child` turn cause. A notice held after
// an Esc (0.78.0) is appended the same way and reaches the parent with the next prompt.
//
// At each `input` the adapter reads the custom-message entries at the end of the branch (after the
// last message entry) and handles those it has not seen through `message_end`.

/**
 * pi-subagents' idle wake prompt (src/shared/parent-wake.js PARENT_WAKE_TEXT, 0.76.1–0.78.0), matched
 * exactly so an owner prompt that merely quotes it is never taken for the wake. A later pi-subagents
 * that rewords it falls back to the pre-ledger-11 handling (cause "other", prompt read as the owner's).
 */
export const SUBAGENT_WAKE_TEXT =
  "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";

/** The exact wake text (surrounding whitespace aside). */
export function isSubagentWakeText(text: unknown): boolean {
  return typeof text === "string" && text.trim() === SUBAGENT_WAKE_TEXT;
}

export function isSubagentWake(source: unknown, text: unknown): boolean {
  return source === "extension" && isSubagentWakeText(text);
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: unknown;
  details: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function keyOf(customType: unknown, content: unknown, details: unknown): string {
  try {
    return JSON.stringify([customType, content ?? null, details ?? null]);
  } catch {
    return String(customType);
  }
}

const CAP = 256;

/** Custom messages already handled, by content key (from `message_end`) and by entry id (from a scan). */
export class CustomSeen {
  private readonly keys: string[] = [];
  private readonly ids = new Set<string>();

  /** A custom message the adapter handled at `message_end`; Pi persists it right after. */
  mark(message: unknown): void {
    if (!isObj(message)) return;
    this.keys.push(keyOf(message.customType, message.content, message.details));
    if (this.keys.length > CAP) this.keys.shift();
  }

  /**
   * An assistant message ended: every custom message marked so far is persisted before it, so none
   * of them can be a trailing entry any more. Dropping their keys keeps a stale key from hiding a
   * later idle message with the same content.
   */
  settle(): void {
    this.keys.length = 0;
  }

  /** Custom-message entries after the last message entry that were not handled yet, oldest first; they count as handled from now on. */
  unseenTrailing(entries: readonly unknown[]): CustomMessage[] {
    const tail: Obj[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!isObj(e)) continue;
      if (e.type === "message") break;
      if (e.type === "custom_message" && typeof e.customType === "string") tail.push(e);
    }
    const out: CustomMessage[] = [];
    for (const e of tail.reverse()) {
      const id = typeof e.id === "string" ? e.id : null;
      if (id && this.ids.has(id)) continue;
      if (id) {
        this.ids.add(id);
        if (this.ids.size > CAP) this.ids.delete(this.ids.values().next().value as string);
      }
      const k = keyOf(e.customType, e.content, e.details);
      const at = this.keys.indexOf(k);
      if (at !== -1) {
        this.keys.splice(at, 1);
        continue;
      }
      out.push({ role: "custom", customType: e.customType as string, content: e.content, details: e.details });
    }
    return out;
  }
}
