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
  /** The usage text (footerText); null when the usage footer is off. */
  usage: string | null;
  /** Other extensions' status texts, in display order. */
  statuses: string[];
}

const SGR_SPLIT = /(\x1b\[[0-9;]*[A-Za-z])/;

/** Visible columns: escape sequences are zero-width, every other code point is one column. */
export function visibleWidth(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")].length;
}

/** Cuts `text` to `width` columns, ending with `…` when it was longer; colour codes are kept. */
export function fitWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const keep = Math.max(0, width - 1);
  let out = "";
  let count = 0;
  text.split(SGR_SPLIT).forEach((part, i) => {
    if (i % 2 === 1) {
      out += part;
      return;
    }
    for (const ch of part) {
      if (count >= keep) return;
      out += ch;
      count++;
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
function cacheSegment(hit: number, warm: boolean, theme: FooterTheme): string {
  const color: FooterColor = hit >= 80 ? "success" : hit >= 40 ? "warning" : "error";
  return `${theme.fg(color, `CH ${Math.round(hit)}%`)} ${warm ? "warm" : "cold"}`;
}

function headline(v: FooterView, theme: FooterTheme, opts: { branch: boolean; cells: number }): string {
  const model = v.model ?? "no-model";
  const segments = [v.thinking ? `${model} • ${v.thinking}` : model];
  if (opts.branch && v.branch) segments.push(v.branch);
  segments.push(contextBar(v.contextPercent, v.contextWindow, opts.cells, theme));
  if (v.cacheHit !== null) segments.push(cacheSegment(v.cacheHit, v.warm, theme));
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
