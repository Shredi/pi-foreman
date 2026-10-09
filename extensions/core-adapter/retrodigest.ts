// Compaction digest and auto-retro (D8). Pure text logic; index.ts wires it to
// session_before_compact / session_compact and writes the files.
//
// Digest: open ledger items, items closed since the last compaction and the last hints, at most
// DIGEST_MAX_LINES lines. It is appended to the pi-foreman prompt section after a compaction and
// names the ledger file as the source of truth.
//
// Auto-retro: the compaction pi-foreman requests (ctx.compact, price tier) carries
// RETRO_INSTRUCTIONS, so the one summary call also ends with `## Retro` (zero extra model calls).
// session_compact extracts that section and appends it, with the traced friction counters, to
// `.workflow/retro/<session>.md`.

export const DIGEST_MAX_LINES = 40;
export const DIGEST_HINTS = 8;
const LINE_MAX = 160;

export const RETRO_HEADING = "## Retro";
export const RETRO_INSTRUCTIONS = `End the summary with a section headed exactly "${RETRO_HEADING}" of at most 10 lines: what was missing in this session (files, allow rules, brief details) and what to enhance in the harness or the briefs.`;

const ITEM_LINE = /^\s*[-*] \[(.)\]\s+(?:deferred:.*? — )?(\d+|V)\.(?:\s|$)/;

export interface LedgerState {
  open: string[];
  closed: Set<string>;
}

/** Open item lines (trimmed) and the ids of closed items ([x]/[X]); fenced blocks skipped. */
export function ledgerState(file: string | null): LedgerState {
  const open: string[] = [];
  const closed = new Set<string>();
  let fenced = false;
  for (const line of (file ?? "").split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    const m = fenced ? null : ITEM_LINE.exec(line);
    if (!m) continue;
    if (m[1] === " ") open.push(line.trim());
    else if (m[1] === "x" || m[1] === "X") closed.add(m[2]);
  }
  return { open, closed };
}

const clip = (s: string): string => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);

/**
 * The digest text and the closed set to remember for the next compaction. `closedBefore` is the
 * closed set at the previous compaction (empty at the first one).
 */
export function buildDigest(opts: { ledgerPath: string | null; ledger: string | null; closedBefore: ReadonlySet<string>; hints: readonly string[] }): { text: string; closed: Set<string> } {
  const st = ledgerState(opts.ledger);
  const head = opts.ledgerPath
    ? [`## Compaction digest`, `The ledger ${opts.ledgerPath} is the source of truth: re-read it before acting on this digest.`]
    : [`## Compaction digest`, `This session has no ledger.`];
  const since = [...st.closed].filter((id) => !opts.closedBefore.has(id));
  const tail: string[] = [];
  tail.push(`Closed since the last compaction: ${since.length ? since.join(", ") : "none"}`);
  const hints = opts.hints.slice(-DIGEST_HINTS);
  if (hints.length) tail.push("Recent hints:", ...hints.map((h) => `  ${clip(h)}`));
  const room = DIGEST_MAX_LINES - head.length - tail.length - 1;
  const open = st.open.map(clip);
  const shown = open.length > room ? [...open.slice(0, room - 1), `… ${open.length - room + 1} more open item(s) in the ledger`] : open;
  const body = opts.ledgerPath ? [`Open items: ${st.open.length}`, ...shown] : [];
  const lines = [...head, ...body, ...(opts.ledgerPath ? tail : [])].slice(0, DIGEST_MAX_LINES);
  return { text: lines.join("\n"), closed: st.closed };
}

/** The `## Retro` section of a compaction summary (heading excluded, at most 10 lines), else null. */
export function extractRetro(summary: string): string | null {
  const lines = summary.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{1,3}\s*Retro\s*:?\s*$/i.test(l.trim()));
  if (at < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(l.trim())) break;
    out.push(l);
  }
  const body = out.join("\n").trim();
  return body ? body.split("\n").slice(0, 10).join("\n") : null;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One line of friction counters from `foreman_retro.py --json`; null input -> "no data". */
export function countersLine(rep: unknown): string {
  const r = rep && typeof rep === "object" ? (rep as Record<string, unknown>) : null;
  const t = r?.trace && typeof r.trace === "object" ? (r.trace as Record<string, unknown>) : null;
  if (!t) return "counters: no data";
  const rv = r?.review && typeof r.review === "object" ? (r.review as Record<string, unknown>) : {};
  const guards = t.guard_blocks && typeof t.guard_blocks === "object" ? Object.values(t.guard_blocks as Record<string, unknown>).reduce<number>((a, v) => a + n(v), 0) : 0;
  const denies = guards + n(t.overlay_blocks) + n(rv.human_denied) + n(rv.review_deny);
  return `counters: denies=${denies} rereviews=${n(t.rereviews)} budget_hits=${n(t.budget_hits)} rung_up=${n(t.rung_up)} child_read_budget=${n(t.child_read_budget)} review_defer_headless=${n(t.review_defer_headless)} turns=${n(t.turns)}`;
}

/** One dated entry of `.workflow/retro/<session>.md`. */
export function retroEntry(opts: { when: Date; reason: string; counters: string; retro: string | null }): string {
  const stamp = opts.when.toISOString().replace(/\.\d+Z$/, "Z");
  return [`## ${stamp} compaction (${opts.reason})`, "", opts.counters, "", opts.retro ?? "(the compaction summary has no Retro section)", ""].join("\n");
}

/** The prompt of `/retro --model`: one foreman turn of at most 10 lines. */
export const MODEL_RETRO_PROMPT = "pi-foreman retro: in at most 10 lines and without any tool call, list what was missing in this session (files, allow rules, brief details) and what to enhance in the harness or the briefs. Reply with the lines only.";

/** The text of the last assistant message in `messages` (agent_end), else "". */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content.trim();
    if (!Array.isArray(m.content)) return "";
    return m.content
      .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("\n")
      .trim();
  }
  return "";
}
