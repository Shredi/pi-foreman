// Standalone HTML pages of the show dir (show.ts): <show dir>/pages/ holds plan.html, note-<n>.html and result.html, and pages.json,
// the index the herdr plan mod lists. The markdown dialect we write for plans and notes is converted here (no library): raw HTML in the
// markdown is escaped, links keep only http, https and relative targets, and mermaid fences become a <picture> with the two themes of the
// already-validated sidecars as data URIs (a fence without sidecars stays a code block). A model-written `html` note is stored as is.
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
  if (!u || /[\u0000- \u007f]/.test(u) || u.startsWith("//")) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(u) ? null : u;
}

/** Inline markdown of one paragraph, cell or heading: code spans, links, strong, emphasis, strikethrough; everything else is escaped text. */
export function inline(src: string): string {
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let s = src.replace(/\u0000/g, "");
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, "$1"))}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^()\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, "&"));
    return href ? hold(`<a href="${escapeHtml(href)}">${emphasis(text)}</a>`) : emphasis(text);
  });
  s = emphasis(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "<em>$1</em>")
    .replace(/(?<!\w)_(?=\S)([^_]*?\S)_(?!\w)/g, "<em>$1</em>");
}

export interface MarkdownOpts {
  /** The HTML for a mermaid fence's text, or null to keep it as a code block. */
  mermaid?: (text: string) => string | null;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (l: string): number => l.length - l.trimStart().length;

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Markdown to an HTML fragment. */
export function renderMarkdown(markdown: string, opts: MarkdownOpts = {}): string {
  return blocks(markdown.replace(/\r\n?/g, "\n").split("\n"), opts, false, 0);
}

const startsBlock = (l: string): boolean => FENCE_OPEN.test(l) || HEADING.test(l) || RULE.test(l) || /^ {0,3}>/.test(l) || /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(l);

function blocks(lines: string[], opts: MarkdownOpts, tight: boolean, depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const [, indent, mark, info] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const run = /^ {0,3}([`~]+)[ \t]*$/.exec(lines[i]);
        if (run && run[1][0] === mark[0] && run[1].length >= mark.length) break;
        body.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), ""));
        i++;
      }
      i++; // the closing line (or the end)
      const lang = info.trim().split(/\s+/)[0] ?? "";
      const text = body.join("\n");
      const diagram = lang === "mermaid" ? opts.mermaid?.(text) : null;
      out.push(diagram ?? `<pre><code${/^[\w+#.-]{1,30}$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (lines[i].trim() && q.length && !startsBlock(lines[i])))) q.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      out.push(`<blockquote>${depth < 8 ? blocks(q, opts, false, depth + 1) : escapeHtml(q.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (tag: string, c: string, k: number): string => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(`<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_c, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const item = ITEM.exec(line);
    if (item && indentOf(line) < 4) {
      const [html, next] = list(lines, i, opts, depth);
      out.push(html);
      i = next;
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-"))) para.push(lines[i++].trim());
    const html = inline(para.join("\n")).replace(/\n/g, " ");
    out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join("\n");
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
        const nextIdx = lines.findIndex((x, k) => k > i && x.trim());
        if (nextIdx < 0 || indentOf(lines[nextIdx]) <= base) break;
        body.push("");
        loose = true;
        i++;
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
  /** The markdown file named when the page is too large. */
  source: string;
}

const STYLE = `:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--mute:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--mute:#9198a1;--line:#3d444d;--code:#161b22;--link:#4493f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:56rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:1.9rem}h2{font-size:1.45rem;border-bottom:1px solid var(--line);padding-bottom:.3em}
.kicker{color:var(--mute);margin:0 0 1.5rem}a{color:var(--link)}
pre{background:var(--code);padding:1rem;overflow:auto;border-radius:6px}code{background:var(--code);padding:.1em .3em;border-radius:4px;font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:.4em .8em}th{background:var(--code)}
blockquote{margin:1em 0;padding:0 1em;color:var(--mute);border-left:4px solid var(--line)}hr{border:0;border-top:1px solid var(--line)}
picture{display:block;margin:1em 0;overflow:auto}img{max-width:100%;height:auto}`;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const shell = (title: string, body: string): string => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>\n${body}\n</main></body></html>\n`;

/** A whole page. Over PAGE_MAX_BYTES the diagrams go back to code blocks; still over it, the page names the markdown file instead of showing it. */
export function renderPage(p: PageInput): string {
  const head = `<h1>${escapeHtml(p.title)}</h1>\n<p class="kicker">${escapeHtml(p.kicker)}</p>`;
  const build = (svgs: ReadonlyMap<string, Svgs> | undefined): string =>
    shell(p.title, `${head}\n${renderMarkdown(p.markdown, { mermaid: (text) => {
      const s = svgs?.get(fenceSha(text));
      return s ? `<picture><source media="(prefers-color-scheme: dark)" srcset="data:image/svg+xml;base64,${b64(s.dark)}"><img alt="diagram" src="data:image/svg+xml;base64,${b64(s.light)}"></picture>` : null;
    } })}`);
  for (const svgs of p.svgs?.size ? [p.svgs, undefined] : [undefined]) {
    const html = build(svgs);
    if (Buffer.byteLength(html, "utf8") <= PAGE_MAX_BYTES) return html;
  }
  return shell(p.title, `${head}\n<p>This page is too large to show (over ${PAGE_MAX_BYTES / 1024} KiB). Open the markdown file instead: <code>${escapeHtml(p.source)}</code></p>`);
}
