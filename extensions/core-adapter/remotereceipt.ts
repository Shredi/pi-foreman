// The child side of the delivery receipt (remote child only). `foreman session remote notice` keeps every report as a line of
// `notices.jsonl` in the handoff dir and answers `sent, not yet confirmed`; the parent writes `notice-ack.json` `{seq, at}` after it applied a
// report. This module reads both local files, shows the state in the footer status and tells the model once per report, as a `nextTurn`
// message (no turn of its own), whether it was delivered or is still unconfirmed after 5 minutes. The model claims delivery from these notes only.
import * as fs from "node:fs";
import * as path from "node:path";

export const REMOTE_RECEIPT_TYPE = "pi-foreman-remote-receipt";
export const RECEIPT_ENTRY = "pi-foreman-remote-receipt";
export const RECEIPT_STATUS_KEY = "pi-foreman-remote-receipt";
/** A report without a receipt after this long is "not confirmed". */
export const REMOTE_ACK_MS = 5 * 60_000;
/** The footer keeps "delivered" this long after the receipt. */
export const DELIVERED_SHOW_MS = 10 * 60_000;
export const PENDING_POLL_MS = 5_000;
export const IDLE_POLL_MS = 30_000;

/** The kinds a report can have in `notices.jsonl`; any other word from the file shows as `report`. */
const REPORT_KINDS = new Set(["plan", "result", "update", "ask", "refused"]);

export interface ReportRecord {
  seq: number;
  kind: string;
  at: number;
}
export interface Receipt {
  seq: number;
  at: number;
}
export interface ReceiptView {
  /** The footer status text, undefined for none. */
  status: string | undefined;
  /** A report is still waiting for its receipt: the files are read every 5 s. */
  pending: boolean;
  /** Reports older than `REMOTE_ACK_MS` without a receipt, ascending. */
  unconfirmed: ReportRecord[];
  /** Reports the receipt covers, ascending. */
  delivered: ReportRecord[];
}

const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The records of `notices.jsonl` as the child wrote them: `closed` notices and malformed lines are left out. */
export function parseReports(text: string): ReportRecord[] {
  const out: ReportRecord[] = [];
  for (const line of text.split("\n")) {
    try {
      const o = JSON.parse(line) as { seq?: unknown; kind?: unknown; at?: unknown };
      const at = typeof o.at === "string" ? Date.parse(o.at) : NaN;
      if (typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq > 0 && typeof o.kind === "string" && o.kind !== "closed" && Number.isFinite(at)) out.push({ seq: o.seq, kind: REPORT_KINDS.has(o.kind) ? o.kind : "report", at });
    } catch {
      // not a record
    }
  }
  return out;
}

/** `notice-ack.json` `{seq, at}`; an unreadable or half-written file is no receipt (null). */
export function parseReceipt(text: string | null): Receipt | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as { seq?: unknown; at?: unknown };
    const at = typeof o.at === "string" ? Date.parse(o.at) : NaN;
    return typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq > 0 && Number.isFinite(at) ? { seq: o.seq, at } : null;
  } catch {
    return null;
  }
}

/** What the footer and the notes say about the reports and the receipt at time `now`. */
export function receiptState(records: ReportRecord[], ack: Receipt | null, now: number): ReceiptView {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const covered = (r: ReportRecord): boolean => !!ack && r.seq <= ack.seq;
  const delivered = sorted.filter(covered);
  const open = sorted.filter((r) => !covered(r));
  const unconfirmed = open.filter((r) => now - r.at > REMOTE_ACK_MS);
  const last = sorted.at(-1);
  let status: string | undefined;
  if (last && !covered(last)) {
    const age = now - last.at;
    status = age > REMOTE_ACK_MS ? `report #${last.seq} (${last.kind}) not confirmed by the parent for ${Math.floor(age / 60_000)} min` : `report #${last.seq} (${last.kind}) sent, not yet confirmed`;
  } else if (last && ack && now - ack.at <= DELIVERED_SHOW_MS) {
    status = `report #${last.seq} delivered to parent at ${clock(ack.at)}`;
  }
  return { status, pending: open.length > 0, unconfirmed, delivered };
}

export interface NotedSeqs {
  unconfirmed: number[];
  delivered: number[];
}

export interface ReceiptDeps {
  /** The handoff dir, or undefined when this is no remote child. */
  handoff: () => string | undefined;
  now?: () => number;
  setStatus: (text: string | undefined) => void;
  /** A `nextTurn` message: no turn of its own. */
  note: (text: string) => void;
  /** Stores the noted seqs in the session entry. */
  persist: (noted: NotedSeqs) => void;
  timer?: (fn: () => void, ms: number) => () => void;
}

const realTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export class ReceiptWatch {
  private noted: NotedSeqs = { unconfirmed: [], delivered: [] };
  private cancel: (() => void) | null = null;
  private status: string | undefined;
  private stopped = true;
  private readonly d: ReceiptDeps;

  constructor(d: ReceiptDeps) {
    this.d = d;
  }

  /** The noted seqs of the session's last `RECEIPT_ENTRY`; a reload repeats no note. */
  restore(entries: readonly unknown[]): void {
    for (const e of [...entries].reverse()) {
      const x = e as { type?: unknown; customType?: unknown; data?: Partial<NotedSeqs> };
      if (x?.type !== "custom" || x.customType !== RECEIPT_ENTRY) continue;
      const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : []);
      this.noted = { unconfirmed: nums(x.data?.unconfirmed), delivered: nums(x.data?.delivered) };
      return;
    }
  }

  start(): void {
    this.stopped = false;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    this.d.setStatus(undefined);
    this.status = undefined;
  }

  /** Reads the files, updates the footer, sends the notes not yet sent; the next read in 5 s while a report is pending, else 30 s. */
  tick(): ReceiptView | null {
    this.cancel?.();
    this.cancel = null;
    const dir = this.d.handoff();
    if (this.stopped || !dir) return null;
    const now = (this.d.now ?? Date.now)();
    const ack = parseReceipt(readText(path.join(dir, "notice-ack.json")));
    const view = receiptState(parseReports(readText(path.join(dir, "notices.jsonl")) ?? ""), ack, now);
    if (view.status !== this.status) {
      this.status = view.status;
      try {
        this.d.setStatus(view.status);
      } catch {
        // the footer is cosmetic
      }
    }
    const lines: string[] = [];
    for (const r of view.unconfirmed) {
      if (this.noted.unconfirmed.includes(r.seq) || this.noted.delivered.includes(r.seq)) continue; // an unreadable ack file is no news about a delivered report
      this.noted.unconfirmed.push(r.seq);
      lines.push(`Your ${r.kind} report #${r.seq} has no receipt from the parent after 5 minutes. Do not say it was delivered.`);
    }
    for (const r of view.delivered) {
      if (this.noted.delivered.includes(r.seq)) continue;
      this.noted.delivered.push(r.seq);
      lines.push(`report #${r.seq} (${r.kind}) delivered to parent at ${clock(ack?.at ?? now)}`);
    }
    if (lines.length) {
      this.d.persist({ unconfirmed: [...this.noted.unconfirmed], delivered: [...this.noted.delivered] });
      for (const l of lines) this.d.note(l);
    }
    this.cancel = (this.d.timer ?? realTimer)(() => void this.tick(), view.pending ? PENDING_POLL_MS : IDLE_POLL_MS);
    return view;
  }
}
