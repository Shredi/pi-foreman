// The two-line pi-foreman footer (r30, footer.style "foreman"): a pure layout of data the adapter already
// holds. Widths count visible columns; theme colour codes are skipped when measuring and cutting.

export type FooterColor = "success" | "warning" | "error" | "dim";
export interface FooterTheme {
  fg(color: FooterColor, text: string): string;
}

export interface FooterView {
  /** Short model id, null when no model is selected. */
  model: string | null;
  /** Thinking level of a reasoning model, null otherwise. */
  thinking: string | null;
  branch: string | null;
  /** Context usage in percent, null while unknown (right after compaction). */
  contextPercent: number | null;
  contextWindow: number;
  /** Cache-read share of the session's prompt tokens, null before the first prompt. */
  cacheHit: number | null;
  /** The adapter's keep-alive marker is up: the prompt cache is warm. */
  warm: boolean;
  /** The cold or downshift glyph in the status slot (warm is then false); absent otherwise. */
  mark?: { state: "cold" | "downshift"; glyph: string };
  /** The usage text (footerText); null when the usage footer is off. */
  usage: string | null;
  /** Other extensions' status texts, in display order. */
  statuses: string[];
}

// An escape sequence: a CSI (colour codes and the like) or an OSC (hyperlinks, titles) ended by BEL or ST.
const ESCAPE_SPLIT = /(\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

// East Asian wide and emoji code points, which a terminal draws in two columns.
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function columnsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
}

/** Visible columns: escape sequences are zero-width, a wide glyph is two columns, every other code point is one. */
export function visibleWidth(text: string): number {
  let columns = 0;
  text.split(ESCAPE_SPLIT).forEach((part, i) => {
    if (i % 2 === 0) for (const ch of part) columns += columnsOf(ch);
  });
  return columns;
}

/** Cuts `text` to `width` columns, ending with `…` when it was longer; colour codes are kept. */
export function fitWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const keep = Math.max(0, width - 1);
  let out = "";
  let count = 0;
  let full = false;
  text.split(ESCAPE_SPLIT).forEach((part, i) => {
    if (i % 2 === 1) {
      out += part;
      return;
    }
    for (const ch of part) {
      const columns = columnsOf(ch);
      if (full || count + columns > keep) {
        full = true;
        return;
      }
      out += ch;
      count += columns;
    }
  });
  return width > 0 ? `${out}…\x1b[0m` : "";
}

/** 200000 -> 200k, 1000000 -> 1.0M, the context size of the footer. */
export function sizeOf(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`;
  return String(Math.round(tokens));
}

/** Context bar: green below 50%, yellow below 80%, red from 80%. */
function contextBar(percent: number | null, contextWindow: number, cells: number, theme: FooterTheme): string {
  const color: FooterColor = percent === null ? "dim" : percent < 50 ? "success" : percent < 80 ? "warning" : "error";
  const filled = percent === null ? 0 : Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)));
  const label = percent === null ? `? of ${sizeOf(contextWindow)}` : `${Math.round(percent)}% of ${sizeOf(contextWindow)}`;
  return `${theme.fg(color, "■".repeat(filled) + "□".repeat(cells - filled))} ${theme.fg(color, label)}`;
}

/** `CH 98%` green from 80, yellow from 40, red below, then the warm or cold marker. */
function cacheSegment(hit: number, warm: boolean, mark: FooterView["mark"], theme: FooterTheme): string {
  const color: FooterColor = hit >= 80 ? "success" : hit >= 40 ? "warning" : "error";
  return `${theme.fg(color, `CH ${Math.round(hit)}%`)} ${mark ? `${mark.glyph} ${mark.state}` : warm ? "warm" : "cold"}`;
}

function headline(v: FooterView, theme: FooterTheme, opts: { branch: boolean; cells: number }): string {
  const model = v.model ?? "no-model";
  const segments = [v.thinking ? `${model} • ${v.thinking}` : model];
  if (opts.branch && v.branch) segments.push(v.branch);
  segments.push(contextBar(v.contextPercent, v.contextWindow, opts.cells, theme));
  if (v.cacheHit !== null) segments.push(cacheSegment(v.cacheHit, v.warm, v.mark, theme));
  return segments.join(" · ");
}

/** Status texts on one line: newlines, tabs and runs of spaces collapse to one space. */
export function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Line 1 drops the branch first, then shrinks the bar to 5 cells; a line still too wide is cut with `…`.
 * Line 2 is the usage text, then ` · ` and the other extensions' statuses, dimmed.
 */
export function renderFooter(v: FooterView, width: number, theme: FooterTheme): string[] {
  const candidates = [
    { branch: true, cells: 10 },
    { branch: false, cells: 10 },
    { branch: false, cells: 5 },
  ].map((opts) => headline(v, theme, opts));
  const line1 = candidates.find((line) => visibleWidth(line) <= width) ?? candidates[candidates.length - 1];
  const foreign = v.statuses.map(sanitizeStatus).filter((s) => s !== "").join(" ");
  const line2 = [v.usage ?? "", foreign].filter((s) => s !== "").join(" · ");
  return [fitWidth(line1, width), fitWidth(theme.fg("dim", line2), width)];
}
