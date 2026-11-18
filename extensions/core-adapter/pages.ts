// Standalone HTML pages of the show dir (show.ts): <show dir>/pages/ holds plan.html, note-<n>.html and result.html, and pages.json,
// the index the herdr plan mod lists. The markdown dialect we write for plans and notes is converted here (no library): raw HTML in the
// markdown is escaped, links keep only http, https and relative targets, and mermaid fences become a <picture> with the two themes of the
// already-validated sidecars as data URIs (a fence without sidecars stays a code block). A model-written `html` note is stored as is.
import { mermaidPres, normalizedPage } from "./htmlmd.ts";
import { fenceSha } from "./mermaid.ts";

export const PAGES_DIR = "pages";
export const PAGES_JSON = "pages.json";
/** The whole page, text included, stays under this; over it the diagrams become code blocks, still over it the page says it is too large. */
export const PAGE_MAX_BYTES = 900 * 1024;
export const NOTES_KEPT = 20;
export const EVENTS_MAX = 50;
const TEXT_MAX = 200;

export type PageKind = "plan" | "note" | "result";

export interface PageEntry {
  id: string;
  kind: PageKind;
  title: string;
  state: string;
  version: number;
  at: string;
  /** Always `fileOfId(id)`. */
  file: string;
}

export interface PageEvent {
  at: string;
  kind: string;
  text: string;
  page?: string;
}

export interface PagesIndex {
  v: 1;
  pages: PageEntry[];
  events: PageEvent[];
}

const NOTE_ID = /^note-([1-9]\d{0,5})$/;

/** The file name of a page id (`plan`, `result`, `note-<n>`), or null: the name is never taken from the index. */
export function fileOfId(id: unknown): string | null {
  if (id === "plan" || id === "result") return `${id}.html`;
  return typeof id === "string" && NOTE_ID.test(id) ? `${id}.html` : null;
}

export const kindOfId = (id: string): PageKind => (id === "plan" ? "plan" : id === "result" ? "result" : "note");

export const noteId = (v: number): string => `note-${v}`;

const clean1 = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim().slice(0, max);

/** pages.json text -> index; entries with a wrong shape, a duplicate id or a `file` that is not derived from the id are dropped. Null: not an index. */
export function parsePagesJson(text: string): PagesIndex | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object" || j.v !== 1 || !Array.isArray(j.pages) || !Array.isArray(j.events)) return null;
    const seen = new Set<string>();
    const pages: PageEntry[] = [];
    for (const p of j.pages as Record<string, unknown>[]) {
      if (!p || typeof p !== "object" || typeof p.id !== "string" || seen.has(p.id)) continue;
      const file = fileOfId(p.id);
      if (!file || p.file !== file || p.kind !== kindOfId(p.id) || typeof p.title !== "string" || typeof p.state !== "string" || typeof p.at !== "string") continue;
      if (!Number.isInteger(p.version) || (p.version as number) < 0) continue;
      seen.add(p.id);
      pages.push({ id: p.id, kind: p.kind as PageKind, title: clean1(p.title, 120), state: clean1(p.state, 40), version: p.version as number, at: clean1(p.at, 40), file });
    }
    const events: PageEvent[] = [];
    for (const e of j.events as Record<string, unknown>[]) {
      if (!e || typeof e !== "object" || typeof e.at !== "string" || typeof e.kind !== "string" || typeof e.text !== "string") continue;
      const page = typeof e.page === "string" && fileOfId(e.page) ? e.page : undefined;
      events.push({ at: clean1(e.at, 40), kind: clean1(e.kind, 40), text: clean1(e.text, TEXT_MAX), ...(page ? { page } : {}) });
    }
    return { v: 1, pages, events: events.slice(-EVENTS_MAX) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- markdown

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** A link target we keep: http, https, or relative (no scheme, not network-path). */
function safeHref(raw: string): string | null {
  const u = raw.trim();
  if (!u || /[\u0000- \u007f]/.test(u) || u.startsWith("//") || u.includes("\\")) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(u) ? null : u;
}

/** Code spans: a run of N backticks, then the next run of exactly N closes it. Linear: runs are paired once, an opener with no partner stays text. */
function codeSpans(s: string, span: (code: string) => string): string {
  const runs: { at: number; len: number }[] = [];
  for (const m of s.matchAll(/`+/g)) runs.push({ at: m.index, len: m[0].length });
  const next: number[] = new Array(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    next[k] = seen.get(runs[k].len) ?? -1;
    seen.set(runs[k].len, k);
  }
  let out = "";
  let pos = 0;
  for (let k = 0; k < runs.length; k++) {
    const j = next[k];
    if (j === -1) continue;
    out += s.slice(pos, runs[k].at) + span(s.slice(runs[k].at + runs[k].len, runs[j].at));
    pos = runs[j].at + runs[j].len;
    k = j;
  }
  return out + s.slice(pos);
}

const LINK_TAIL = /\(([^()\s]+)(?:\s+&quot;[^&]*&quot;)?\)/y;

/** `[text](url "title")` on escaped text. Linear: each `]` is tried once, and with no `]` left no later `[` can match. */
function links(s: string, link: (text: string, url: string) => string): string {
  let out = "";
  let pos = 0;
  let from = 0;
  let close = -2; // the `]` after `from`, -1 none
  const failed = new Set<number>();
  while ((from = s.indexOf("[", from)) !== -1) {
    if (close < from) close = s.indexOf("]", from);
    if (close === -1) break;
    if (close > from + 1 && !failed.has(close)) {
      LINK_TAIL.lastIndex = close + 1;
      const m = LINK_TAIL.exec(s);
      if (m) {
        out += s.slice(pos, from) + link(s.slice(from + 1, close), m[1]);
        pos = from = LINK_TAIL.lastIndex;
        continue;
      }
      failed.add(close);
    }
    from++;
  }
  return out + s.slice(pos);
}

/** Inline markdown of one paragraph, cell or heading: code spans, links, strong, emphasis, strikethrough; everything else is escaped text. */
export function inline(src: string): string {
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let s = src.replace(/\u0000/g, "");
  s = codeSpans(s, (code) => hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, "$1"))}</code>`));
  s = escapeHtml(s);
  s = links(s, (text, url) => {
    const href = safeHref(url.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
    return href ? hold(`<a href="${escapeHtml(href)}">${emphasis(text)}</a>`) : emphasis(text);
  });
  s = emphasis(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
}

/**
 * Wrap `delim`…`delim` pairs in `tag`: an opener is followed by a non-space, a closer is preceded by one; the first closer wins. `word` makes `_`-style
 * delimiters need a non-word before the opener and after the closer. Linear: an opener with no closer means no later opener has one either.
 */
function pairs(s: string, delim: string, tag: string, word: boolean): string {
  const n = delim.length;
  const isWord = (c: string | undefined): boolean => c !== undefined && /\w/.test(c);
  let out = "";
  let i = 0; // scanned up to here
  let from = 0;
  while ((from = s.indexOf(delim, from)) !== -1) {
    const c = s[from + n];
    if (c === undefined || /\s/.test(c) || (word && isWord(s[from - 1]))) {
      from++;
      continue;
    }
    let j = s.indexOf(delim, from + n + 1);
    while (j !== -1 && (/\s/.test(s[j - 1]) || (word && isWord(s[j + n])))) j = s.indexOf(delim, j + 1);
    if (j === -1) break;
    out += `${s.slice(i, from)}<${tag}>${s.slice(from + n, j)}</${tag}>`;
    i = from = j + n;
  }
  return out + s.slice(i);
}

function emphasis(s: string): string {
  return pairs(pairs(pairs(s, "**", "strong", false), "__", "strong", true), "~~", "del", false)
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "<em>$1</em>")
    .replace(/(?<!\w)_(?=\S)([^_]*?\S)_(?!\w)/g, "<em>$1</em>");
}

export interface MarkdownOpts {
  /** The HTML for a mermaid fence's text, or null to keep it as a code block. */
  mermaid?: (text: string) => string | null;
  /** When set, a level-2 section whose heading text this returns true for renders folded (`<details class="fold" id="…">`, the heading as an `h2` inside its summary). */
  fold?: (heading: string) => boolean;
  /** The plan layout, by position only: the `For the owner` section is wrapped (goal, numbered path, trailing alerts in a side column) and `Open questions` is a highlighted section. Independent of `fold`. */
  ownerLayout?: boolean;
}

/** The plan page's fold: every `##` section except `For the owner` and `Open questions` (case-insensitive, trimmed). */
export const foldPlanSection = (heading: string): boolean => !["for the owner", "open questions"].includes(heading.trim().toLowerCase());

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}([`~]+)[ \t]*$/;

/** A top-level fenced code block starting at `lines[at]`: its indent, marker run, info string, the line index of its closing fence (`lines.length` when unclosed) and the first line after it; null when no fence opens there. */
export function scanFence(lines: readonly string[], at: number): { indent: string; mark: string; info: string; close: number; next: number } | null {
  const open = FENCE_OPEN.exec(lines[at] ?? "");
  if (!open || (open[2][0] === "`" && open[3].includes("`"))) return null;
  const [, indent, mark, info] = open;
  let close = at + 1;
  while (close < lines.length) {
    const run = FENCE_CLOSE.exec(lines[close]);
    if (run && run[1][0] === mark[0] && run[1].length >= mark.length) break;
    close++;
  }
  return { indent, mark, info, close, next: Math.min(close + 1, lines.length) };
}

const HEADING_OPEN = /^ {0,3}(#{1,6})(?=[ \t])/;
const isBlank = (c: string): boolean => c === " " || c === "\t";

/** An ATX heading line: its level and text (closing `#` run and outer blanks dropped), or null. Scans once, no backtracking. */
function headingOf(line: string): { level: number; text: string } | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  const tail = line.slice(m[0].length); // starts with a blank
  let e = tail.length;
  while (e > 0 && isBlank(tail[e - 1])) e--;
  let j = e;
  while (j > 0 && tail[j - 1] === "#") j--;
  let end = e;
  if (j < e && j >= 1 && isBlank(tail[j - 1])) {
    let k = j - 1;
    while (k > 0 && isBlank(tail[k - 1])) k--;
    if (k > 0 || j - k >= 2) end = k;
  }
  let b = 0;
  while (b < end && isBlank(tail[b])) b++;
  return { level: m[1].length, text: tail.slice(b, end) };
}
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (l: string): number => l.length - l.trimStart().length;

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const sectionKey = (heading: string): string => heading.trim().toLowerCase();

/** A fragment id from a heading: lowercase ascii words joined by `-`; `section` when nothing is left. */
const slugOf = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";

export interface RenderedPart {
  html: string;
  /** The part is the wrapped `For the owner` section. */
  owner?: boolean;
}

export interface FoldedSection {
  id: string;
  heading: string;
}

/** The owner section: the heading and the goal, path and other blocks in the main column, the trailing run of top-level alerts in the side column. DOM order is source order. */
function ownerSection(heading: string, body: string[], opts: MarkdownOpts): string {
  const items = blockList(body, opts, false, 0);
  let side = items.length;
  while (side > 0 && items[side - 1].kind === "alert") side--;
  const shown = (b: Blk, i: number): string => (i === 0 && b.kind === "p" ? b.html.replace(/^<p>/, '<p class="goal">') : b.kind === "ol" ? b.html.replace(/^<ol/, '<ol class="path"') : b.html);
  const main = [`<h2>${inline(heading)}</h2>`, ...items.slice(0, side).map(shown)];
  const aside = items.slice(side).map(shown);
  return `<section class="owner">\n<div class="o-main">\n${main.join("\n")}\n</div>${aside.length ? `\n<div class="o-side">\n${aside.join("\n")}\n</div>` : ""}\n</section>`;
}

/** Markdown to its top-level parts (and the folded sections among them), see renderMarkdown. */
export function renderParts(markdown: string, opts: MarkdownOpts = {}): { parts: RenderedPart[]; folds: FoldedSection[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const { fold, ownerLayout } = opts;
  if (!fold && !ownerLayout) return { parts: [{ html: blocks(lines, opts, false, 0) }].filter((p) => p.html !== ""), folds: [] };
  const parts: RenderedPart[] = [];
  const folds: FoldedSection[] = [];
  const ids = new Set<string>();
  let start = 0; // the first line of the part being collected
  let heading: string | null = null; // the heading text of the part when it is a level-2 section
  const flush = (end: number): void => {
    if (end <= start) return;
    const key = heading === null ? "" : sectionKey(heading);
    if (heading !== null && fold?.(heading)) {
      const base = slugOf(heading);
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      folds.push({ id, heading });
      parts.push({ html: `<details class="fold" id="${id}"><summary><h2>${inline(heading)}</h2></summary>\n${blocks(lines.slice(start + 1, end), opts, false, 0)}\n</details>` });
    } else if (heading !== null && ownerLayout && key === "for the owner") parts.push({ html: ownerSection(heading, lines.slice(start + 1, end), opts), owner: true });
    else if (heading !== null && ownerLayout && key === "open questions") parts.push({ html: `<section class="questions">\n${blocks(lines.slice(start, end), opts, false, 0)}\n</section>` });
    else parts.push({ html: blocks(lines.slice(start, end), opts, false, 0) });
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = scanFence(lines, i);
    if (fence) {
      i = fence.next - 1;
      continue;
    }
    const h = headingOf(lines[i]);
    if (h?.level !== 2 || !lines[i].startsWith("##")) continue; // only a heading at column 0 is a top-level section
    flush(i);
    start = i;
    heading = h.text;
  }
  flush(lines.length);
  return { parts: parts.filter((p) => p.html !== ""), folds };
}

/** Markdown to an HTML fragment. */
export const renderMarkdown = (markdown: string, opts: MarkdownOpts = {}): string =>
  renderParts(markdown, opts)
    .parts.map((p) => p.html)
    .join("\n");

const ALERT_MARK = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

/** The alert type (lower case) of a quote whose first line is exactly a marker and that has a body; null for any other quote. */
function alertOf(quote: readonly string[]): string | null {
  const m = ALERT_MARK.exec(quote[0] ?? "");
  return m && quote.slice(1).some((l) => l.trim()) ? m[1].toLowerCase() : null;
}

const startsBlock = (l: string): boolean => FENCE_OPEN.test(l) || headingOf(l) !== null || RULE.test(l) || /^ {0,3}>/.test(l) || /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(l);

interface Blk {
  html: string;
  kind: "p" | "ol" | "ul" | "alert" | "other";
}

const blocks = (lines: string[], opts: MarkdownOpts, tight: boolean, depth: number): string =>
  blockList(lines, opts, tight, depth)
    .map((b) => b.html)
    .join("\n");

function blockList(lines: string[], opts: MarkdownOpts, tight: boolean, depth: number): Blk[] {
  const out: Blk[] = [];
  const add = (html: string, kind: Blk["kind"] = "other"): void => {
    out.push({ html, kind });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = scanFence(lines, i);
    if (fence) {
      const { indent, info } = fence;
      const body = lines.slice(i + 1, fence.close).map((l) => l.replace(new RegExp(`^ {0,${indent.length}}`), ""));
      i = fence.next;
      const lang = info.trim().split(/\s+/)[0] ?? "";
      const text = body.join("\n");
      const diagram = lang === "mermaid" ? opts.mermaid?.(text) : null;
      add(diagram ?? `<pre><code${/^[\w+#.-]{1,30}$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>`);
      continue;
    }
    const h = headingOf(line);
    if (h) {
      add(`<h${h.level}>${inline(h.text)}</h${h.level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      add("<hr>");
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (lines[i].trim() && q.length && !startsBlock(lines[i])))) q.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      const alert = depth < 8 ? alertOf(q) : null;
      if (alert) add(`<blockquote class="callout callout-${alert}" data-alert="${alert}">${blocks(q.slice(1), opts, false, depth + 1)}</blockquote>`, "alert");
      else add(`<blockquote>${depth < 8 ? blocks(q, opts, false, depth + 1) : escapeHtml(q.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (tag: string, c: string, k: number): string => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
      add(`<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_c, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const item = ITEM.exec(line);
    if (item && indentOf(line) < 4) {
      const [html, next] = list(lines, i, opts, depth);
      add(html, /^<ol[ >]/.test(html) ? "ol" : "ul");
      i = next;
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-"))) para.push(lines[i++].trim());
    const html = inline(para.join("\n")).replace(/\n/g, " ");
    add(tight ? html : `<p>${html}</p>`, "p");
  }
  return out;
}

/** One list starting at `start`; returns its HTML and the next line. Items deeper than the marker belong to the item. */
function list(lines: string[], start: number, opts: MarkdownOpts, depth: number): [string, number] {
  const first = ITEM.exec(lines[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let nextIdx = i + 1;
        while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
        if (nextIdx >= lines.length || indentOf(lines[nextIdx]) <= base) break;
        for (; i < nextIdx; i++) body.push("");
        loose = true;
        continue;
      }
      if (indentOf(l) > base) body.push(l.slice(Math.min(indentOf(l), base + 2)));
      else if (!ITEM.test(l) && !startsBlock(l) && body[body.length - 1] !== "") body.push(l.trim());
      else break;
      i++;
    }
    items.push(body);
  }
  const tag = ordered ? "ol" : "ul";
  const startAt = ordered && Number(first[2].replace(/\D/g, "")) !== 1 ? ` start="${Number(first[2].replace(/\D/g, ""))}"` : "";
  const html = items.map((b) => `<li>${depth < 8 ? blocks(b, opts, !loose, depth + 1) : escapeHtml(b.join("\n"))}</li>`).join("\n");
  return [`<${tag}${startAt}>\n${html}\n</${tag}>`, i];
}

// ---------------------------------------------------------------- pages

export interface Svgs {
  dark: string;
  light: string;
}

export interface PageInput {
  title: string;
  /** The line under the title: kind, version, state. */
  kicker: string;
  markdown: string;
  /** Sidecar SVG text by fence sha; absent: every mermaid fence stays a code block. */
  svgs?: ReadonlyMap<string, Svgs>;
  /** Level-2 sections folded in the page (see MarkdownOpts.fold). */
  fold?: (heading: string) => boolean;
  /** The markdown file named when the page is too large. */
  source: string;
}

// The five alert colours (accent, tint) for light and dark; the stylesheets set them as custom properties.
const ALERT_LIGHT = "--note:#2563eb;--note-b:#eff5ff;--tip:#15803d;--tip-b:#ecfaf1;--imp:#7c3aed;--imp-b:#f5f0ff;--warn:#b45309;--warn-b:#fff7e8;--caut:#c2262d;--caut-b:#fff0f0";
const ALERT_DARK = "--note:#6ea8fe;--note-b:#16233a;--tip:#4ade80;--tip-b:#132a1d;--imp:#b794f6;--imp-b:#241a3a;--warn:#f0b354;--warn-b:#2e2312;--caut:#f87171;--caut-b:#331718";
const alertTypes = (scope: string): string => [["note", "note"], ["tip", "tip"], ["important", "imp"], ["warning", "warn"], ["caution", "caut"]].map(([t, v]) => `${scope}.callout-${t}{--c:var(--${v});--cb:var(--${v}-b)}`).join("");

/** The harness stylesheet of every markdown page (also the `<style>` of instructions/plan-skeleton.html). No `content:`, hidden or zero-size rules: the converter reports those (htmlmd.ts). */
export const STYLE = `:root{color-scheme:light dark;--fg:#1b1f24;--bg:#eef1f5;--card:#fff;--mute:#5c6673;--line:#d7dde5;--soft:#f3f5f8;--link:#1f6feb;--accent:#1f6feb;${ALERT_LIGHT}}
@media (prefers-color-scheme:dark){:root{--fg:#e8ebef;--bg:#0f1216;--card:#181c22;--mute:#97a1ad;--line:#2b313a;--soft:#20252d;--link:#79b0ff;--accent:#4c8dff;${ALERT_DARK}}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:52rem;margin:0 auto;padding:2rem 1.5rem 4rem}body.plan main{max-width:74rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:1.9rem;margin-top:.3em}h2{font-size:1.35rem}h3{font-size:1.1rem}
.kicker{color:var(--mute);margin:0 0 1.5rem;font-size:.9rem}a{color:var(--link)}
pre{background:var(--soft);padding:1rem;overflow:auto;border-radius:8px}code{background:var(--soft);padding:.08em .32em;border-radius:4px;font:.86em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow:auto;margin:1rem 0}th,td{border:1px solid var(--line);padding:.45em .8em;vertical-align:top}th{background:var(--soft);text-align:left}
blockquote{margin:1em 0;padding:0 1em;color:var(--mute);border-left:3px solid var(--line)}hr{border:0;border-top:1px solid var(--line)}
.callout{margin:1rem 0;padding:.8rem 1rem;border-radius:10px;border:1px solid var(--c);border-left-width:5px;background:var(--cb);color:var(--fg)}
.callout>:first-child{margin-top:0}.callout>:last-child{margin-bottom:0}.callout ul,.callout ol{padding-left:1.1rem;margin:.3rem 0}.callout li{margin:.2rem 0}
.callout>p:first-child>strong:first-child{color:var(--c)}
${alertTypes("")}
section.owner{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:1.25rem;align-items:start;margin:1rem 0}.o-main:only-child{grid-column:1/-1}
@media (max-width:860px){section.owner{grid-template-columns:1fr}}
.o-main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:0 1.5rem 1rem;overflow:hidden}
.o-main>h2{margin:0 -1.5rem 0;padding:.5rem 1.5rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:#fff;background:var(--accent)}
p.goal{margin:0 -1.5rem 1rem;padding:1rem 1.5rem 1.2rem;background:var(--accent);color:#fff;font-size:1.3rem;line-height:1.4;font-weight:500}p.goal strong{color:#fff}
ol.path{padding-left:2.4rem}ol.path>li{padding:.5rem 0 .5rem .3rem;border-bottom:1px dashed var(--line)}ol.path>li:last-child{border-bottom:0}ol.path>li::marker{color:var(--accent);font-weight:800;font-size:1.25em}
.o-side .callout{margin:0 0 1rem;background:var(--card);border-width:0 0 0 5px;box-shadow:0 1px 3px #0000001a}
details.fold{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.8rem 1.3rem;margin:.6rem 0}details.fold>summary{cursor:pointer}
details.fold>summary>h2{display:inline;margin:0;padding:0;font-size:1.1rem}details.fold[open]>summary{margin-bottom:.6rem}details.fold[open]{max-width:56rem}
nav.index{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:1.5rem 0 .5rem}nav.index span{color:var(--mute);font-size:.85rem;margin-right:.3rem}
nav.index a{font-size:.85rem;text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:.1rem .65rem;color:var(--fg)}nav.index a:hover{border-color:var(--link)}
section.questions{border:2px solid var(--imp);border-radius:12px;padding:.2rem 1.2rem;margin:1.5rem 0;background:var(--imp-b)}section.questions>h2{margin-top:.8rem;color:var(--imp)}
picture{display:block;margin:1em 0;overflow:auto}img{max-width:100%;height:auto}`;

/** The alert look for the rulings below an HTML plan: the model's page brings no harness stylesheet, so the rules are scoped to the rulings block. */
const RULINGS_STYLE = `#pi-foreman-rulings{${ALERT_LIGHT};--ink:#1b1f24}
@media (prefers-color-scheme:dark){#pi-foreman-rulings{${ALERT_DARK};--ink:#e8ebef}}
#pi-foreman-rulings .callout{margin:1rem 0;padding:.8rem 1rem;border-radius:10px;border:1px solid var(--c);border-left-width:5px;background:var(--cb);color:var(--ink)}
#pi-foreman-rulings .callout>:first-child{margin-top:0}#pi-foreman-rulings .callout>:last-child{margin-bottom:0}#pi-foreman-rulings .callout>p:first-child>strong:first-child{color:var(--c)}
${alertTypes("#pi-foreman-rulings ")}`;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const pictureOf = (s: Svgs): string => `<picture><source media="(prefers-color-scheme: dark)" srcset="data:image/svg+xml;base64,${b64(s.dark)}"><img alt="diagram" src="data:image/svg+xml;base64,${b64(s.light)}"></picture>`;

const shell = (title: string, body: string, wide = false): string => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body${wide ? ' class="plan"' : ""}><main>\n${body}\n</main></body></html>\n`;

/** The markdown body of a page; a plan page gets its index of folded sections right after the owner section (at the top without one). */
function planBody(p: PageInput, svgs: ReadonlyMap<string, Svgs> | undefined): string {
  const { parts, folds } = renderParts(p.markdown, {
    fold: p.fold,
    ownerLayout: p.fold !== undefined,
    mermaid: (text) => {
      const s = svgs?.get(fenceSha(text));
      return s ? pictureOf(s) : null;
    },
  });
  const links = folds.map((f) => `<a href="#${f.id}">${inline(f.heading).replace(/<\/?a(?:\s[^>]*)?>/g, "")}</a>`);
  const html = parts.map((x) => x.html);
  if (links.length) html.splice(parts.findIndex((x) => x.owner) + 1, 0, `<nav class="index"><span>In the details</span>${links.join("")}</nav>`);
  return html.join("\n");
}

/** A whole page. Over PAGE_MAX_BYTES the diagrams go back to code blocks; still over it, the page names the markdown file instead of showing it. */
export function renderPage(p: PageInput): string {
  const plan = p.fold !== undefined; // only a plan page folds sections; it also gets the owner layout, the index and the wide page
  const head = `<h1>${escapeHtml(p.title)}</h1>\n<p class="kicker">${escapeHtml(p.kicker)}</p>`;
  const build = (svgs: ReadonlyMap<string, Svgs> | undefined): string =>
    shell(p.title, `${head}\n${planBody(p, svgs)}`, plan);
  for (const svgs of p.svgs?.size ? [p.svgs, undefined] : [undefined]) {
    const html = build(svgs);
    if (Buffer.byteLength(html, "utf8") <= PAGE_MAX_BYTES) return html;
  }
  return shell(p.title, `${head}\n<p>This page is too large to show (over ${PAGE_MAX_BYTES / 1024} KiB). Open the markdown file instead: <code>${escapeHtml(p.source)}</code></p>`);
}

// ---------------------------------------------------------------- HTML plan page

export interface HtmlPlanPageInput {
  title: string;
  /** The harness state banner: plan version, state, hash prefix. */
  kicker: string;
  /** The model's page, as written. */
  html: string;
  /** The rulings sidecar's markdown (empty: none); rendered below the page by the harness's own escaping renderer. */
  rulings: string;
  /** Sidecar SVG text by fence sha; absent: every mermaid `<pre>` stays text. */
  svgs?: ReadonlyMap<string, Svgs>;
  /** The page file named when the page is too large. */
  source: string;
}

/** The index after the `>` of the first `<body ...>` tag outside comments, or -1. One forward scan. */
function bodyOpenEnd(html: string): number {
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return -1;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) return -1;
      i = end + 3;
      continue;
    }
    if (/^<body[\s>/]/i.test(html.slice(lt, lt + 6))) {
      const gt = html.indexOf(">", lt);
      return gt < 0 ? -1 : gt + 1;
    }
    i = lt + 1;
  }
}

/** The index of the last `</body` (any case), or -1. */
function bodyCloseAt(html: string): number {
  let at = -1;
  for (const m of html.matchAll(/<\/body/gi)) at = m.index;
  return at;
}

/**
 * The plan page of an HTML plan: the model's page as written with (a) the harness state banner right after the `<body>` open tag (at the start
 * when there is none), (b) each `<pre class="mermaid">` replaced by the rendered diagram once its sidecars exist, and (c) the rulings below
 * the page in a harness block. Over PAGE_MAX_BYTES the diagrams go back to text; still over it, the page names the file instead of showing it.
 */
export function renderHtmlPlanPage(p: HtmlPlanPageInput): string {
  const banner = `<div id="pi-foreman-banner" style="margin:0;padding:.5rem 1rem;font:14px system-ui,sans-serif;background:#1f2328;color:#fff">${escapeHtml(p.kicker)}</div>`;
  const rulings = p.rulings.trim()
    ? `<section id="pi-foreman-rulings" style="max-width:56rem;margin:2rem auto;padding:1rem 1.25rem;border-top:2px solid #888;font:16px/1.6 system-ui,sans-serif"><style>${RULINGS_STYLE}</style><h2>Rulings (below the approved page; they do not change its version)</h2>\n${renderMarkdown(p.rulings)}\n</section>`
    : "";
  const page = normalizedPage(p.html);
  const pres = p.svgs?.size ? mermaidPres(p.html) : [];
  const build = (svgs: ReadonlyMap<string, Svgs> | undefined): string => {
    let out = "";
    let at = 0;
    for (const m of svgs ? pres : []) {
      const s = svgs?.get(fenceSha(m.text));
      if (!s) continue;
      out += page.slice(at, m.start) + pictureOf(s);
      at = m.end;
    }
    out += page.slice(at);
    const open = bodyOpenEnd(out);
    out = open < 0 ? banner + out : out.slice(0, open) + banner + out.slice(open);
    const close = bodyCloseAt(out);
    return close < 0 ? out + rulings : out.slice(0, close) + rulings + out.slice(close);
  };
  for (const svgs of p.svgs?.size ? [p.svgs, undefined] : [undefined]) {
    const html = build(svgs);
    if (Buffer.byteLength(html, "utf8") <= PAGE_MAX_BYTES) return html;
  }
  return shell(p.title, `<h1>${escapeHtml(p.title)}</h1>\n<p class="kicker">${escapeHtml(p.kicker)}</p>\n<p>This page is too large to show (over ${PAGE_MAX_BYTES / 1024} KiB). Open the page file instead: <code>${escapeHtml(p.source)}</code></p>`);
}
