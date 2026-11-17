// HTML plan page -> markdown copy (checkpoint.ts readPlan). Harness-owned and dependency-free, so every installation gets the same text
// for the same page (an optional converter package would not). It handles the structural subset a plan page uses: headings, paragraphs,
// lists, tables, pre/code (a `<pre class="mermaid">` becomes a mermaid fence), blockquote, details, links, emphasis and image alt text;
// script, style, head, template, noscript and comments are dropped, any other tag keeps its text. Pure and deterministic. Linear:
// one forward scan with a bounded element depth, no regex that backtracks over unbounded input, input cut at 256 KiB.
// Alongside the text it reports the hidden-style facts of the page (CSS or attributes that hide or add words), for the reviewer.

export const HTML_MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 64;

export interface HiddenFact {
  kind: string;
  count: number;
}

export interface HtmlMarkdown {
  /** The markdown, one trailing newline, empty for a page without text. */
  markdown: string;
  /** The first `<h1>` text, else the `<title>` text, else null. */
  title: string | null;
  /** Hidden-style facts in a fixed order; only kinds that occur. */
  hidden: HiddenFact[];
  /** The input was longer than HTML_MAX_BYTES and was cut. */
  truncated: boolean;
}

interface El {
  tag: string;
  attrs: Map<string, string>;
  kids: Node[];
}
type Node = El | string;

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "area", "base", "col", "embed", "source", "track", "param"]);
/** Elements whose text is not markup; their end tag is searched for directly. */
const RAW = new Set(["script", "style", "title", "textarea"]);
const SKIP = new Set(["head", "template", "noscript"]);
const INLINE = new Set(["a", "span", "b", "strong", "i", "em", "code", "kbd", "mark", "small", "sub", "sup", "u", "s", "del", "ins", "strike", "abbr", "cite", "q", "label", "time", "var", "samp", "font", "button", "bdi", "bdo", "data", "dfn", "img", "br", "wbr", "input", "select", "textarea", "svg", "big", "tt", "output", "meter", "progress"]);
/** Opening one of these closes an open `p` on top of the stack. */
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);
/** Implied end tags: opening the key closes the listed open elements, looking down the stack up to a stop element. */
const IMPLIED: Record<string, { close: string[]; stop: string[] }> = {
  body: { close: ["head"], stop: [] },
  li: { close: ["li"], stop: ["ul", "ol"] },
  dt: { close: ["dt", "dd"], stop: ["dl"] },
  dd: { close: ["dt", "dd"], stop: ["dl"] },
  td: { close: ["td", "th"], stop: ["tr", "table"] },
  th: { close: ["td", "th"], stop: ["tr", "table"] },
  tr: { close: ["tr", "td", "th"], stop: ["table", "thead", "tbody", "tfoot"] },
  thead: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table"] },
  tbody: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table"] },
  tfoot: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table"] },
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", copy: "©", reg: "®", trade: "TM", mdash: "-", ndash: "-", hellip: "...", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•", middot: "·", times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔", check: "✓", deg: "°",
  plusmn: "±", ne: "≠", le: "≤", ge: "≥", sect: "§", para: "¶", euro: "€", pound: "£", yen: "¥", cent: "¢", hearts: "♥",
  nbsp: String.fromCharCode(0xa0), zwj: String.fromCharCode(0x200d), zwnj: String.fromCharCode(0x200c), shy: "",
};

function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
    const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : String.fromCharCode(0xfffd);
  });
}

const HIDDEN_PATTERNS: [string, RegExp][] = [
  ["display:none", /display\s*:\s*none/gi],
  ["visibility:hidden", /visibility\s*:\s*hidden/gi],
  ["content:", /(?<![\w-])content\s*:/gi],
  ["font-size:0", /font-size\s*:\s*0+(?:\.0+)?(?:px|em|rem|pt|%|ex|ch|vw|vh)?\s*(?:[;}!"'\s]|$)/gi],
  ["opacity:0", /opacity\s*:\s*0+(?:\.0+)?\s*(?:[;}!"'\s]|$)/gi],
];
const HIDDEN_KINDS = [...HIDDEN_PATTERNS.map(([k]) => k), "hidden attribute"];

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isNameChar = (c: string): boolean => !isSpace(c) && c !== "/" && c !== ">" && c !== "=";

function trimEndWs(s: string): string {
  let e = s.length;
  while (e > 0 && isSpace(s[e - 1])) e--;
  return s.slice(0, e);
}

// ---------------------------------------------------------------- parse

/** The opening tag at `i` (`html[i]` is `<`, a letter follows): its name, attributes (first occurrence wins, values decoded) and the index after the `>`; null when the input ends inside the tag. */
function readOpenTag(html: string, i: number): { tag: string; attrs: Map<string, string>; end: number } | null {
  const n = html.length;
  let j = i + 1;
  while (j < n && isNameChar(html[j])) j++;
  const tag = html.slice(i + 1, j).toLowerCase().slice(0, 40);
  const attrs = new Map<string, string>();
  while (j < n) {
    while (j < n && (isSpace(html[j]) || html[j] === "/")) j++;
    if (j >= n) return null;
    if (html[j] === ">") return { tag, attrs, end: j + 1 };
    const a = j;
    while (j < n && isNameChar(html[j])) j++;
    if (j === a) {
      j++; // a stray `=`
      continue;
    }
    const name = html.slice(a, j).toLowerCase();
    let k = j;
    while (k < n && isSpace(html[k])) k++;
    let value = "";
    if (html[k] === "=") {
      k++;
      while (k < n && isSpace(html[k])) k++;
      const q = html[k];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, k + 1);
        if (end < 0) return null;
        value = html.slice(k + 1, end);
        j = end + 1;
      } else {
        const s = k;
        while (k < n && !isSpace(html[k]) && html[k] !== ">") k++;
        value = html.slice(s, k);
        j = k;
      }
    }
    if (!attrs.has(name)) attrs.set(name, decode(value));
  }
  return null;
}

interface Parsed {
  root: El;
  title: string | null;
  counts: Map<string, number>;
}

function parse(html: string): Parsed {
  const root: El = { tag: "#root", attrs: new Map(), kids: [] };
  const stack: El[] = [root];
  const counts = new Map<string, number>();
  let title: string | null = null;
  const bump = (kind: string, n: number): void => {
    if (n > 0) counts.set(kind, (counts.get(kind) ?? 0) + n);
  };
  const scanStyle = (css: string): void => {
    for (const [kind, re] of HIDDEN_PATTERNS) {
      re.lastIndex = 0;
      let n = 0;
      while (re.exec(css)) n++;
      bump(kind, n);
    }
  };
  const top = (): El => stack[stack.length - 1];
  const addText = (raw: string): void => {
    if (raw) top().kids.push(decode(raw));
  };
  const popTo = (len: number): void => {
    stack.length = Math.max(1, len);
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    i = lt;
    const next = html[i + 1] ?? "";
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (next === "/") {
      const c = html[i + 2] ?? "";
      if (!/[A-Za-z]/.test(c)) {
        const end = html.indexOf(">", i + 2);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      let j = i + 2;
      while (j < n && isNameChar(html[j])) j++;
      const name = html.slice(i + 2, j).toLowerCase();
      const end = html.indexOf(">", j);
      if (end < 0) break;
      i = end + 1;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === name) {
          popTo(k);
          break;
        }
      }
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      addText("<");
      i++;
      continue;
    }
    const open = readOpenTag(html, i);
    if (!open) break;
    const { tag, attrs } = open;
    i = open.end;
    if (attrs.has("hidden")) bump("hidden attribute", 1);
    const style = attrs.get("style");
    if (style) scanStyle(style);
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}`, "gi");
      re.lastIndex = i;
      const m = re.exec(html);
      const text = html.slice(i, m ? m.index : n);
      if (tag === "style") scanStyle(text);
      else if (tag === "title") title ??= decode(text).replace(/[ \t\n\f\r]+/g, " ").trim() || null;
      else if (tag === "textarea") top().kids.push({ tag, attrs, kids: [decode(text)] });
      if (!m) break;
      const end = html.indexOf(">", m.index);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (CLOSES_P.has(tag)) while (top().tag === "p" && stack.length > 1) popTo(stack.length - 1);
    const implied = IMPLIED[tag];
    if (implied) {
      let target = -1;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (implied.stop.includes(stack[k].tag)) break;
        if (implied.close.includes(stack[k].tag)) target = k;
      }
      if (target >= 0) popTo(target);
    }
    const el: El = { tag, attrs, kids: [] };
    top().kids.push(el);
    if (!VOID.has(tag) && stack.length < MAX_DEPTH) stack.push(el);
  }
  return { root, title, counts };
}

// ---------------------------------------------------------------- render

const BR = "\u0001";
const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption", "ul", "ol", "li", "dl", "dt", "dd", "table", "pre", "blockquote", "details", "summary", "hr", "address", "form", "fieldset", "body", "html", "center", "caption", "tr", "td", "th", "thead", "tbody", "tfoot"]);

interface Blk {
  text: string;
  kind: "p" | "list" | "fence" | "other";
}

const isEl = (n: Node): n is El => typeof n !== "string";
const collapse = (s: string): string => s.replace(/[ \t\n\f\r]+/g, " ");
const isBlockEl = (el: El): boolean => BLOCK_TAGS.has(el.tag) || (!INLINE.has(el.tag) && !VOID.has(el.tag));

/** Paragraph lines that would read as markdown structure get a backslash, so a paragraph never turns into a heading, list, fence or table. */
const LINE_START = /^(?:#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|`{3,}|~{3,}|={3,}|-{3,}|_{3,}|\*{3,}|<!--|\|)/;

function paragraph(raw: string): string {
  const lines = collapse(raw).split(BR).map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => (LINE_START.test(l) ? `\\${l}` : l)).join("  \n");
}

function textOf(kids: readonly Node[], pre: boolean): string {
  let out = "";
  for (const k of kids) {
    if (typeof k === "string") out += k;
    else if (k.tag === "br") out += pre ? "\n" : " ";
    else out += textOf(k.kids, pre);
  }
  return out;
}

function wrap(mark: string, s: string): string {
  const a = s.length - s.trimStart().length;
  const b = s.length - s.trimEnd().length;
  if (a + b >= s.length) return s;
  return s.slice(0, a) + mark + s.slice(a, s.length - b) + mark + s.slice(s.length - b);
}

const longestRun = (s: string, ch: string): number => {
  let best = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
};

const ESCAPED_HREF: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };

function linkTarget(href: string | undefined): string | null {
  const h = href?.trim();
  if (!h || h.length > 2000 || /^(?!https?:|mailto:)[A-Za-z][A-Za-z0-9+.-]*:/i.test(h)) return null;
  return h.replace(/[\s()<>]/g, (c) => ESCAPED_HREF[c] ?? "%20");
}

function inline(kids: readonly Node[]): string {
  let out = "";
  for (const k of kids) out += typeof k === "string" ? k : inlineEl(k);
  return out;
}

function inlineEl(el: El): string {
  switch (el.tag) {
    case "br":
      return BR;
    case "img":
      return el.attrs.get("alt") ?? "";
    case "strong":
    case "b":
      return wrap("**", inline(el.kids));
    case "em":
    case "i":
      return wrap("*", inline(el.kids));
    case "del":
    case "s":
    case "strike":
      return wrap("~~", inline(el.kids));
    case "code": {
      const text = collapse(textOf(el.kids, false)).trim();
      if (!text) return "";
      const mark = "`".repeat(longestRun(text, "`") + 1);
      return text.startsWith("`") || text.endsWith("`") ? `${mark} ${text} ${mark}` : `${mark}${text}${mark}`;
    }
    case "a": {
      const text = inline(el.kids);
      const target = linkTarget(el.attrs.get("href"));
      const label = collapse(text.replaceAll(BR, " ")).trim();
      if (!target) return text;
      return `[${(label || target).replace(/[[\]]/g, "\\$&")}](${target})`;
    }
    case "textarea":
      return textOf(el.kids, false);
    default:
      if (SKIP.has(el.tag)) return "";
      return isBlockEl(el) ? ` ${inline(el.kids)} ` : inline(el.kids);
  }
}

function blocksOf(kids: readonly Node[]): Blk[] {
  const out: Blk[] = [];
  let run = "";
  const flush = (): void => {
    const t = paragraph(run);
    run = "";
    if (t) out.push({ text: t, kind: "p" });
  };
  for (const k of kids) {
    if (typeof k === "string") run += k;
    else if (SKIP.has(k.tag)) continue;
    else if (!isBlockEl(k)) run += inlineEl(k);
    else {
      flush();
      out.push(...blockEl(k));
    }
  }
  flush();
  return out;
}

const joinBlocks = (bs: readonly Blk[]): string => bs.map((b) => b.text).join("\n\n");

function prefixLines(text: string, first: string, rest: string): string {
  return text.split("\n").map((l, i) => (i === 0 ? first + l : l ? rest + l : l)).join("\n");
}

function blockEl(el: El): Blk[] {
  const level = /^h([1-6])$/.exec(el.tag);
  if (level) {
    const t = collapse(inline(el.kids).replaceAll(BR, " ")).trim();
    return t ? [{ text: `${"#".repeat(Number(level[1]))} ${t}`, kind: "other" }] : [];
  }
  switch (el.tag) {
    case "hr":
      return [{ text: "---", kind: "other" }];
    case "pre":
      return preBlock(el);
    case "ul":
    case "ol":
      return listBlock(el);
    case "table":
      return tableBlock(el);
    case "blockquote": {
      const t = joinBlocks(blocksOf(el.kids));
      return t ? [{ text: t.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"), kind: "other" }] : [];
    }
    case "summary":
    case "dt": {
      const t = collapse(inline(el.kids).replaceAll(BR, " ")).trim();
      return t ? [{ text: `**${t}**`, kind: "p" }] : [];
    }
    default:
      return blocksOf(el.kids);
  }
}

/** The text of a `<pre>`, whether it is a mermaid diagram, and the code language (empty when none). Null for a pre without text. */
function preFence(el: El): { text: string; mermaid: boolean; lang: string } | null {
  const code = el.kids.find((k): k is El => isEl(k) && k.tag === "code");
  const mermaid = /(?:^|[ \t\n\f\r])mermaid(?:$|[ \t\n\f\r])/.test(el.attrs.get("class") ?? "");
  const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]{1,30})(?:\s|$)/.exec(code?.attrs.get("class") ?? "")?.[1] ?? "";
  const text = trimEndWs(textOf(el.kids, true).replace(/^\n/, ""));
  return text.trim() ? { text, mermaid, lang } : null;
}

function preBlock(el: El): Blk[] {
  const f = preFence(el);
  if (!f) return [];
  const mark = "`".repeat(Math.max(3, longestRun(f.text, "`") + 1));
  return [{ text: `${mark}${f.mermaid ? "mermaid" : f.lang}\n${f.text}\n${mark}`, kind: "fence" }];
}

function listBlock(el: El): Blk[] {
  const ordered = el.tag === "ol";
  const start = Number.parseInt(el.attrs.get("start") ?? "", 10);
  let n = Number.isInteger(start) && start >= 0 && start < 1e9 ? start : 1;
  const items: string[] = [];
  const after: Blk[] = [];
  for (const k of el.kids) {
    if (typeof k === "string" || SKIP.has(k.tag)) continue;
    if (k.tag !== "li") {
      after.push(...blockEl(isBlockEl(k) ? k : { tag: "p", attrs: new Map(), kids: [k] }));
      continue;
    }
    const bs = blocksOf(k.kids);
    if (!bs.length) continue;
    const marker = ordered ? `${n++}. ` : "- ";
    let body = bs[0].text;
    for (let b = 1; b < bs.length; b++) body += ((bs[b].kind === "list" || bs[b].kind === "fence") && bs[b - 1].kind !== "list" ? "\n" : "\n\n") + bs[b].text;
    items.push(prefixLines(body, marker, " ".repeat(marker.length)));
  }
  return [...(items.length ? [{ text: items.join("\n"), kind: "list" as const }] : []), ...after];
}

function tableBlock(el: El): Blk[] {
  const rows: string[][] = [];
  let caption = "";
  const cellText = (c: El): string => collapse(inline(c.kids).replaceAll(BR, " ")).trim().replace(/\|/g, "\\|");
  const walk = (kids: readonly Node[]): void => {
    for (const k of kids) {
      if (typeof k === "string") continue;
      if (k.tag === "caption") caption ||= collapse(inline(k.kids).replaceAll(BR, " ")).trim();
      else if (k.tag === "thead" || k.tag === "tbody" || k.tag === "tfoot") walk(k.kids);
      else if (k.tag === "tr") {
        const cells = k.kids.filter((c): c is El => isEl(c) && (c.tag === "td" || c.tag === "th")).map(cellText);
        if (cells.length) rows.push(cells);
      }
    }
  };
  walk(el.kids);
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cap: Blk[] = caption ? [{ text: paragraph(caption), kind: "p" }] : [];
  if (!cols) return cap;
  const line = (cells: string[]): string => `| ${Array.from({ length: cols }, (_c, i) => cells[i] ?? "").join(" | ")} |`;
  const text = [line(rows[0]), line(Array.from({ length: cols }, () => "---")), ...rows.slice(1).map(line)].join("\n");
  return [...cap, { text, kind: "other" }];
}

function firstH1(kids: readonly Node[], depth: number): string | null {
  for (const k of kids) {
    if (typeof k === "string") continue;
    if (k.tag === "h1") {
      const t = collapse(textOf(k.kids, false)).trim();
      if (t) return t;
    }
    if (depth < MAX_DEPTH && !SKIP.has(k.tag)) {
      const t = firstH1(k.kids, depth + 1);
      if (t) return t;
    }
  }
  return null;
}

/** The page as the converter reads it: cut at HTML_MAX_BYTES characters, no BOM, LF line ends, no control characters. */
function normalize(input: string): { html: string; truncated: boolean } {
  const truncated = input.length > HTML_MAX_BYTES;
  const cut = truncated ? input.slice(0, HTML_MAX_BYTES) : input;
  const html = (cut.charCodeAt(0) === 0xfeff ? cut.slice(1) : cut)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "");
  return { html, truncated };
}

/**
 * The `<pre class="mermaid">` elements of a page, in source order, as spans of the normalized page text (normalizedPage) with the diagram text
 * the markdown copy holds for each (so a renderer can find the copy's diagram by its text). One forward scan.
 */
export function mermaidPres(input: string): { start: number; end: number; text: string }[] {
  const { html } = normalize(input);
  const out: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (!/[A-Za-z]/.test(html[lt + 1] ?? "")) {
      i = lt + 1;
      continue;
    }
    const open = readOpenTag(html, lt);
    if (!open) break;
    if (RAW.has(open.tag) || open.tag === "pre") {
      const re = new RegExp(`</${open.tag}`, "gi");
      re.lastIndex = open.end;
      const m = re.exec(html);
      if (!m) break;
      const gt = html.indexOf(">", m.index);
      if (gt < 0) break;
      if (open.tag === "pre") {
        const pre = parse(html.slice(lt, gt + 1)).root.kids.find((k): k is El => isEl(k) && k.tag === "pre");
        const f = pre ? preFence(pre) : null;
        if (f?.mermaid) out.push({ start: lt, end: gt + 1, text: f.text });
      }
      i = gt + 1;
      continue;
    }
    i = open.end;
  }
  return out;
}

/** The page text `mermaidPres` spans refer to. */
export const normalizedPage = (input: string): string => normalize(input).html;

/** Convert a plan page. The input is cut at HTML_MAX_BYTES characters; `markdown` always ends in one newline unless the page has no text. */
export function htmlToMarkdown(input: string): HtmlMarkdown {
  const { html, truncated } = normalize(input);
  const parsed = parse(html);
  const text = joinBlocks(blocksOf(parsed.root.kids));
  return {
    markdown: text ? `${text}\n` : "",
    title: firstH1(parsed.root.kids, 0) ?? parsed.title,
    hidden: HIDDEN_KINDS.flatMap((kind) => (parsed.counts.has(kind) ? [{ kind, count: parsed.counts.get(kind) as number }] : [])),
    truncated,
  };
}

/** The reviewer's line for hidden-style facts, or null when the page has none. */
export function hiddenFactsLine(hidden: readonly HiddenFact[]): string | null {
  return hidden.length ? hidden.map((h) => `${h.kind} x${h.count}`).join(", ") : null;
}
