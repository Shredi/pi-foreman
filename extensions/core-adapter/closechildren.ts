// `/foreman close` also closes the session's own child sessions (R3b point 4): each registry entry (sessions.json)
// whose `parent` is this session's opener id and whose status is open or pending gets `foreman:close`; the registry
// is polled until every sent child reports `closed` (or the bounded wait ends). One report line per child. Never throws.
import { closeText, readRegistry, writeRegistry } from "./session.ts";

export const CHILD_POLL_MS = 1_000;

export interface CloseChildrenDeps {
  agentDir: string;
  /** The id registry entries carry as `parent` for this session (session.ts openerIntercomId). */
  opener: string;
  /** Send `text` to `to` over intercom; the outbox status (`sent`, `timeout`, ...). */
  send: (to: string, text: string) => Promise<string>;
  /** `close.childWaitMs` (0 = send and report without waiting). */
  waitMs: number;
  /** Injectable timer: resolves after `ms`. */
  sleep: (ms: number) => Promise<void>;
}

type Outcome = "closed" | "refused" | "timeout" | "not sent";

export async function closeChildren(d: CloseChildrenDeps): Promise<string[]> {
  try {
    const open = readRegistry(d.agentDir).sessions.filter((s) => s.parent === d.opener && s.child !== d.opener && (s.status === undefined || s.status === "open" || s.status === "pending"));
    if (open.length === 0) return [];
    const outcome = new Map<string, Outcome | "sent">();
    const reasons = new Map<string, string>();
    for (const s of open) {
      let status = "failed";
      try {
        status = await d.send(s.child, closeText());
      } catch {
        // reported as not sent
      }
      if (status === "sent" || status === "timeout") outcome.set(s.child, "sent");
      else {
        outcome.set(s.child, "not sent");
        reasons.set(s.child, status);
      }
    }
    const sent = open.filter((s) => outcome.get(s.child) === "sent");
    if (sent.length > 0) {
      const reg = readRegistry(d.agentDir);
      for (const e of reg.sessions) if (outcome.get(e.child) === "sent" && e.status !== "closed") e.status = "closing";
      writeRegistry(d.agentDir, reg);
    }
    let waited = 0;
    for (;;) {
      const reg = readRegistry(d.agentDir);
      let pending = 0;
      for (const s of sent) {
        const e = [...reg.sessions].reverse().find((x) => x.child === s.child);
        if (e?.status === "closed") outcome.set(s.child, "closed");
        else if (e?.last?.kind === "refused" && e.status !== "closing") {
          outcome.set(s.child, "refused");
          reasons.set(s.child, e.last.path ?? "");
        } else pending++;
      }
      if (pending === 0 || waited >= d.waitMs) {
        for (const s of sent) if (outcome.get(s.child) === "sent") outcome.set(s.child, "timeout");
        break;
      }
      const step = Math.min(CHILD_POLL_MS, d.waitMs - waited);
      await d.sleep(step);
      waited += step;
    }
    return open.map((s) => {
      const o = outcome.get(s.child) as Outcome;
      const why = reasons.get(s.child);
      return `child ${s.label} (${s.child}): ${o}${o === "timeout" ? ` after ${waited} ms` : why ? ` (${why})` : ""}`;
    });
  } catch (err) {
    return [`child sessions: could not be closed (${(err as Error).message})`];
  }
}
