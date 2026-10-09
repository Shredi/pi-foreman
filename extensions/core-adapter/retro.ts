// Per-session retro state (D8): ledger hints log, compaction digest, launch -> cited items, and the
// pending `/retro --model` file. index.ts wires the events; the text logic is in hints.ts and
// retrodigest.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { HintLog } from "./hints.ts";
import { buildDigest, countersLine, retroEntry } from "./retrodigest.ts";

export class RetroState {
  readonly hints = new HintLog();
  /** Closed item ids at the last compaction (digest "closed since"). */
  private closedBefore = new Set<string>();
  private pending: { text: string; closed: Set<string> } | null = null;
  /** The digest appended to the pi-foreman section since the last compaction ("" before the first). */
  digest = "";
  /** The pi-foreman section without the digest (set by before_agent_start). */
  base = "";
  /** Foreman: ledger items a launch cited, by run id until its run end. */
  readonly launchItems = new Map<string, string[]>();
  /** `/retro --model`: the file the next foreman agent_end appends its reply to. */
  modelFile: string | null = null;

  /** session_before_compact: build the digest; it takes effect only when the compaction succeeds. */
  prepare(ledgerPath: string | null): void {
    let ledger: string | null = null;
    try {
      ledger = ledgerPath ? fs.readFileSync(ledgerPath, "utf8") : null;
    } catch {
      // unreadable: the digest says open items 0 and names the path
    }
    this.pending = buildDigest({ ledgerPath, ledger, closedBefore: this.closedBefore, hints: this.hints.last(8) });
  }

  /** session_compact: commit the prepared digest; the section to re-put, or null when unchanged. */
  commit(): string | null {
    if (!this.pending) return null;
    this.digest = this.pending.text;
    this.closedBefore = this.pending.closed;
    this.pending = null;
    return this.base ? withDigest(this.base, this.digest) : null;
  }

  /** session_compact_failed: drop the prepared digest. */
  drop(): void {
    this.pending = null;
  }
}

export function withDigest(base: string, digest: string): string {
  return [base, digest].filter(Boolean).join("\n\n");
}

/** A session id as a file name. */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

/** Append one compaction retro entry to `<cwd>/.workflow/retro/<session>.md`; the file path. */
export function appendCompactionRetro(cwd: string, sessionId: string, opts: { reason: string; counters: unknown; retro: string | null; when?: Date }): string {
  const file = path.join(cwd, ".workflow", "retro", `${safeName(sessionId)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = fs.existsSync(file) ? "" : `# pi-foreman retro: session ${sessionId}\n\n`;
  fs.appendFileSync(file, head + retroEntry({ when: opts.when ?? new Date(), reason: opts.reason, counters: countersLine(opts.counters), retro: opts.retro }), "utf8");
  return file;
}

/** `/retro` output file in the state dir: `<state>/retro/retro-<session>.md`, one dated entry per run. */
export function appendStateRetro(stateDir: string, sessionId: string, text: string, when = new Date()): string {
  const file = path.join(stateDir, "retro", `retro-${safeName(sessionId)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `## ${when.toISOString().replace(/\.\d+Z$/, "Z")} /retro\n\n${text.trim()}\n\n`, "utf8");
  return file;
}

/** Append the model-written section (at most 10 lines) to a `/retro` output file. */
export function appendModelRetro(file: string, reply: string): void {
  const lines = reply.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  fs.appendFileSync(file, `### Model retro\n\n${lines.length ? lines.join("\n") : "(no reply)"}\n\n`, "utf8");
}
