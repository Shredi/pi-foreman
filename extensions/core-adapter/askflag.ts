// `/foreman flag-ask [note]` (R31c): the owner flags the last ask they answered in this session as unnecessary. The Permission System dialog choices
// are a fixed set, so the flag is a pi-foreman command. This module only remembers the last answered ask and builds the `ask_flag` trace record;
// nothing here (or anywhere) reads a flag back into a permission rule: a flag never allows anything.
// One source fills it: the owner's answer to an ask (index.ts overlay branch and gate dialog).
import { dialogFamily, dialogFields } from "./dialogs.ts";

export interface AnsweredAsk {
  family: string;
  /** The dialog class. */
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

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class AskFlag {
  private last: AnsweredAsk | null = null;

  /** The overlay answered an ask (ask-approved / ask-denied): its command, rule and answer. */
  overlay(a: { command: string; rule?: string | null; approved: boolean; session: string; now?: number }): void {
    const f = dialogFields(a.command) as { class?: string };
    this.last = { family: dialogFamily(a.command), cls: str(f.class) || dialogFamily(a.command), rule: a.rule || "-", surface: "overlay", answer: a.approved ? "approved" : "denied", command: a.command, session: a.session, at: a.now ?? Date.now() };
  }

  /** The trace record for the last answered ask of `session` with an optional note, or null when there is none (nothing is written then). */
  flag(session: string, note?: string): Record<string, unknown> | null {
    const a = this.last;
    if (!a || a.session !== session) return null;
    return { event: "ask_flag", family: a.family, class: a.cls, rule: a.rule, surface: a.surface, decision: a.answer, command: a.command, ...(note?.trim() ? { note: note.trim() } : {}) };
  }
}
