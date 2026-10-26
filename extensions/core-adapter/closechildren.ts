// `/foreman close` also closes the session's own child sessions (R3b point 4): each registry entry (sessions.json)
// whose `parent` is this session's opener id and whose status is open or pending gets `foreman:close`; the registry
// is polled until every sent child reports `closed` (or the bounded wait ends). One report line per child. Never throws.
import type { PullNow, RunRemote } from "./remotepull.ts";
import { closeText, readRegistry, writeRegistry } from "./session.ts";
import type { SessionEntry } from "./session.ts";

export const CHILD_POLL_MS = 1_000;
/** While waiting, the outbox of a sent remote child is pulled this often. */
export const REMOTE_PULL_MS = 5_000;

const isRemote = (s: SessionEntry): boolean => typeof s.machine === "string";
const who = (s: SessionEntry): string => (isRemote(s) ? `${s.label}@${String(s.machine)}` : s.label);

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
  /** Poll a remote child's outbox now (remotepull.ts); runs every 5 s while a sent remote child is awaited. */
  pullNow?: PullNow;
  /** Run a `foreman_session.py` verb through the pull queue (remotepull.ts). */
  runRemote?: RunRemote;
}

type Outcome = "closed" | "refused" | "timeout" | "not sent";

export async function closeChildren(d: CloseChildrenDeps): Promise<string[]> {
  try {
    const mine = readRegistry(d.agentDir).sessions.filter((s) => s.parent === d.opener && s.child !== d.opener && (s.status === undefined || s.status === "open" || s.status === "pending"));
    // a remote child is closed through the runner (`close-remote`); without one it is reported, not touched
    const skipped = d.runRemote ? [] : mine.filter(isRemote).map((s) => `${who(s)}: not closed (no remote runner)`);
    const open = mine.filter((s) => d.runRemote || !isRemote(s));
    if (open.length === 0) return skipped;
    const outcome = new Map<string, Outcome | "sent">();
    const reasons = new Map<string, string>();
    for (const s of open) {
      let status = "failed";
      try {
        if (isRemote(s)) {
          const r = await d.runRemote!(["close-remote", s.child]);
          status = r.code === 0 && !r.error && !r.timedOut ? "sent" : /\[([A-Za-z0-9_]+)\]/.exec(r.stderr)?.[1] ?? (r.timedOut ? "timeout" : "failed");
        } else status = await d.send(s.child, closeText());
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
      for (const e of reg.sessions) if (outcome.get(e.child) === "sent" && e.status !== "closed" && !isRemote(e)) e.status = "closing"; // close-remote marked the remote ones
      writeRegistry(d.agentDir, reg);
    }
    let waited = 0;
    let pulled = 0;
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
      if (d.pullNow && waited - pulled >= REMOTE_PULL_MS) {
        pulled = waited;
        for (const s of sent) {
          if (!isRemote(s) || outcome.get(s.child) !== "sent") continue;
          try {
            await d.pullNow(s.child);
          } catch {
            // the pull module records its own errors
          }
        }
      }
    }
    return [...skipped, ...open.map((s) => {
      const o = outcome.get(s.child) as Outcome;
      const why = reasons.get(s.child);
      return `child ${who(s)} (${s.child}): ${o}${o === "timeout" ? ` after ${waited} ms` : why ? ` (${why})` : ""}`;
    })];
  } catch (err) {
    return [`child sessions: could not be closed (${(err as Error).message})`];
  }
}
