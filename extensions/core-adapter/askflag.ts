// `/foreman flag-ask [note]` (R31c): the owner flags the last ask they answered in this session as unnecessary. The Permission System dialog choices
// are a fixed set, so the flag is a pi-foreman command. This module only remembers the last answered ask and builds the `ask_flag` trace record;
// nothing here (or anywhere) reads a flag back into a permission rule: a flag never allows anything.
// Two sources fill it: the overlay's own ask answer (index.ts overlay branch) and the PS `permissions:ui_prompt` / `permissions:decision` events
// (user resolutions only; a policy or review resolution is not an answer of the owner).
import { classify, effectCtx } from "./effects.ts";
import { dialogFamily, dialogFields } from "./dialogs.ts";
import { reviewValue } from "./review.ts";

type PromptLike = { requestId?: unknown; surface?: unknown; request?: { surface?: unknown; matchedPattern?: unknown } };

export interface AnsweredAsk {
  family: string;
  /** Effect class (PS path: effects.ts classify) or the overlay's dialog class. */
  cls: string;
  /** The asking rule or guard; "-" when unknown. */
  rule: string;
  surface: string;
  /** What the owner answered: "approved" or "denied". */
  answer: string;
  /** The complete command, unredacted in memory; trace.ts redacts secret-looking values when it is written. */
  command: string;
  session: string;
  at: number;
}

// PermissionDecisionEvent.resolution values that are an answer of the owner (policy, authorizer, auto and error resolutions are not).
const USER_ANSWER: Record<string, string> = { user_approved: "approved", user_approved_for_session: "approved", user_denied: "denied" };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class AskFlag {
  private last: AnsweredAsk | null = null;
  private readonly pending = new Map<string, { command: string; surface: string; rule: string }>();

  /** The overlay answered an ask (ask-approved / ask-denied): its command, rule and answer. */
  overlay(a: { command: string; rule?: string | null; approved: boolean; session: string; now?: number }): void {
    const f = dialogFields(a.command) as { class?: string };
    this.last = { family: dialogFamily(a.command), cls: str(f.class) || dialogFamily(a.command), rule: a.rule || "-", surface: "overlay", answer: a.approved ? "approved" : "denied", command: a.command, session: a.session, at: a.now ?? Date.now() };
  }

  /** `permissions:ui_prompt`: remember the prompt's command until its decision arrives. */
  prompt(d: unknown): void {
    const p = (d && typeof d === "object" ? d : {}) as PromptLike;
    if (typeof p.requestId !== "string") return;
    let command = "";
    try {
      command = reviewValue(p as never);
    } catch {
      command = "";
    }
    this.pending.set(p.requestId, { command, surface: str(p.surface) || str(p.request?.surface) || "permission", rule: str(p.request?.matchedPattern) });
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** `permissions:decision`: only a decision the owner made is an answered ask. */
  decision(d: unknown, session: string, cwd: string, now = Date.now()): void {
    const p = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    const id = str(p.requestId);
    const ask = this.pending.get(id);
    if (!id || !ask) return;
    this.pending.delete(id);
    const answer = USER_ANSWER[str(p.resolution)];
    if (!answer || !ask.command) return;
    let cls = "unknown";
    try {
      cls = classify(ask.command, effectCtx(cwd));
    } catch {
      cls = "unknown";
    }
    this.last = { family: dialogFamily(ask.command), cls, rule: ask.rule || "-", surface: ask.surface, answer, command: ask.command, session, at: now };
  }

  /** The trace record for the last answered ask of `session` with an optional note, or null when there is none (nothing is written then). */
  flag(session: string, note?: string): Record<string, unknown> | null {
    const a = this.last;
    if (!a || a.session !== session) return null;
    return { event: "ask_flag", family: a.family, class: a.cls, rule: a.rule, surface: a.surface, decision: a.answer, command: a.command, ...(note?.trim() ? { note: note.trim() } : {}) };
  }
}
