// Model layer of the pi-foreman-plan herdr-app mod: pure functions, no herdr import, no I/O, ESM.
// Markdown block splitter, Myers line diff, change marks, sanitiser, Diff-view hunks, anchor resolution.
// The helpers below the marked line are copies from the Agents mod's model.js (../pi-foreman/): the herdr-app loader refuses an
// import that leaves the mod's own folder ("resolves outside the application directory"), so they cannot be imported.
// model.parity.test.mjs holds the copies equal to the originals.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const int = (v) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---- copies of ../pi-foreman/model.js --------------------------------------------------------------------------------

const MAX_DEPTH = 40;
const MAX_NODES = 2000;
const SAFE_URL = /^https:\/\/[A-Za-z0-9][A-Za-z0-9\-._~:/?#[\]@!$()*+,;=%]*$/;

export function isSafeHttpsUrl(url) {
  return typeof url === "string" && url.length <= 2048 && SAFE_URL.test(url);
}

export function openerArgv(platform, url) {
  if (!isSafeHttpsUrl(url)) return null;
  if (platform === "darwin") return ["open", url];
  if (platform === "linux") return ["xdg-open", url];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  return null;
}

export function openFailure(resultOrError) {
  try {
    const r = resultOrError;
    let text;
    if (r instanceof Error) text = r.message;
    else if (r !== null && typeof r === "object" && "code" in r) {
      if (r.code === 0) return "";
      const first = (typeof r.stderr === "string" ? r.stderr : "").split(/\r?\n/).map(plainLine).find(Boolean) ?? "";
      text = `exit ${typeof r.code === "number" || typeof r.code === "string" ? r.code : "?"}${first ? `: ${first}` : ""}`;
    } else text = typeof r === "string" ? r : r?.message ?? "";
    const line = plainLine(text);
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  } catch { return ""; }
}
const plainLine = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g, "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();

export function buildTree(nodes) {
  const copies = new Map();
  const all = [];
  const up = new Map();
  const walk = (n, depth) => {
    if (copies.has(n) || depth > MAX_DEPTH || all.length > MAX_NODES) return copies.get(n) ?? null;
    const c = { ...n, children: [] };
    copies.set(n, c);
    all.push(c);
    for (const k of Array.isArray(n.children) ? n.children : []) {
      if (!isObj(k)) continue;
      const kc = walk(k, depth + 1);
      if (kc && !up.has(kc)) { up.set(kc, c); c.children.push(kc); }
    }
    return c;
  };
  for (const n of Array.isArray(nodes) ? nodes : []) if (isObj(n)) walk(n, 0);
  const byKey = new Map(all.filter((n) => n.kind === "session" && n.key).map((n) => [n.key, n]));
  for (const n of all) {
    if (n.kind !== "session" || !n.parent || up.has(n)) continue;
    const p = byKey.get(n.parent);
    if (!p || p === n) continue;
    let a = p;
    while (a && a !== n) a = up.get(a);
    if (a === n) continue; // cycle
    up.set(n, p);
    p.children.push(n);
  }
  for (const n of all) {
    n.sessions = n.children.filter((c) => c.kind === "session");
    n.workers = n.children.filter((c) => c.kind !== "session");
  }
  return all.filter((n) => n.kind === "session" && !up.has(n));
}

export function allSessions(tops) {
  const out = [];
  const visit = (n, d) => {
    if (!n || d > MAX_DEPTH) return;
    if (n.kind === "session") out.push(n);
    for (const c of n.sessions ?? []) visit(c, d + 1);
  };
  for (const t of Array.isArray(tops) ? tops : []) visit(t, 0);
  return out;
}

const isEnded = (n) => n.state === "closed" || n.state === "lost";
const pidOf = (a) => int(a?.pid) ?? int(a?.foreground?.pid);

export function joinAgents(agents, tree, machine = null, taken = new Set()) {
  const out = new Map();
  if (!Array.isArray(agents)) return out;
  const prefix = machine ? `${machine}/` : "";
  const byTerminal = new Map();
  for (const n of allSessions(tree)) {
    if (n.hcTerminal && n.state !== "done" && !n.machine && !byTerminal.has(n.hcTerminal)) byTerminal.set(n.hcTerminal, n);
  }
  for (const a of agents) {
    const addr = str(a?.address);
    if (!addr || (machine ? !addr.startsWith(prefix) : addr.includes("/"))) continue;
    const n = byTerminal.get(addr.slice(prefix.length));
    if (!n) continue;
    const pid = pidOf(a);
    if (pid !== null && n.pid !== null && pid !== n.pid) continue;
    out.set(addr, n);
  }
  if (machine) return out;
  const used = new Set([...out.values(), ...taken]);
  const byPid = new Map();
  for (const n of allSessions(tree)) {
    if (n.pid !== null && n.state !== "done" && !isEnded(n) && !n.machine && !used.has(n) && !byPid.has(n.pid)) byPid.set(n.pid, n);
  }
  for (const a of agents) {
    const addr = str(a?.address);
    const pid = pidOf(a);
    if (!addr || addr.includes("/") || out.has(addr) || pid === null) continue;
    const n = byPid.get(pid);
    if (!n || used.has(n)) continue;
    used.add(n);
    out.set(addr, n);
  }
  return out;
}

export function joinPath(dir, name) {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

export function fmtSince(ms) {
  const mins = Math.floor(Math.max(0, num(ms)) / 60000);
  const steps = [[1440, "d"], [60, "h"], [1, "m"]];
  const hit = steps.find(([size]) => mins >= size);
  return hit ? `${Math.floor(mins / hit[0])}${hit[1]}` : "<1m";
}

// ---- end of the copies ----------------------------------------------------------------------------------------------

export const MAX_LINES = 4000; // per side; above it no marks are computed
export const MAX_EDITS = 1500; // edit distance above which no marks are computed
export const MAX_BLOCK_LINES = 4000;

// ---- plan appendix (port of isAppendixLine from extensions/core-adapter/checkpoint.ts) ---------------------------

/** A ruling / decision-log / addendum heading or the `<!-- plan-appendix -->` marker: the plan body ends before it. */
export function isAppendixLine(line) {
  const l = String(line).replace(/\s+$/, "");
  return l === "<!-- plan-appendix -->" || /^#{2,3}[ \t]+(?:addendum|addenda|rulings?|parent ruling|decision log)(?=$|:|[ \t]-|[ \t]\(|[ \t]\d)/i.test(l);
}

/** Index of the first appendix line, or lines.length when there is none. */
export function bodyEnd(lines) {
  const at = lines.findIndex(isAppendixLine);
  return at < 0 ? lines.length : at;
}

export const toLines = (md) => String(md ?? "").replace(/\r\n?/g, "\n").split("\n");

// ---- fences and blocks ---------------------------------------------------------------------------------------------

/** `{ch, len, info}` when `line` opens a code fence (3+ backticks or tildes, at most 3 spaces of indent), else null.
 *  A backtick fence's info string holds no backtick (CommonMark). */
export function fenceOpen(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { ch: m[1][0], len: m[1].length, info: m[2].trim() };
}

/** True when `line` closes `open`: the same character, at least the opening length, nothing else on the line. */
export function fenceCloses(line, open) {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(m) && m[1][0] === open.ch && m[1].length >= open.len;
}

const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Blocks of a markdown document by CommonMark rules: a fence is one block (to its closing fence, or to the end when it
 *  never closes), an ATX heading is a block of its own, everything else splits on blank lines (paragraphs, lists, tables,
 *  quotes). Block `{kind, start, end, fenceMarkers}` over `lines`, `end` exclusive; `fenceMarkers` are the line indexes of
 *  the fence marker lines. */
export function splitBlocks(lines) {
  const out = [];
  let from = -1;
  const flush = (to) => { if (from >= 0 && to > from) out.push({ kind: "text", start: from, end: to, fenceMarkers: [] }); from = -1; };
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (open) {
      flush(i);
      let j = i + 1;
      while (j < lines.length && !fenceCloses(lines[j], open)) j++;
      const closed = j < lines.length;
      out.push({ kind: "fence", info: open.info, start: i, end: closed ? j + 1 : lines.length, fenceMarkers: closed ? [i, j] : [i] });
      i = closed ? j : lines.length;
      continue;
    }
    if (lines[i].trim() === "") { flush(i); continue; }
    if (HEADING.test(lines[i])) { flush(i); out.push({ kind: "heading", start: i, end: i + 1, fenceMarkers: [] }); continue; }
    if (from < 0) from = i;
  }
  flush(lines.length);
  return out;
}

// ---- Myers diff ----------------------------------------------------------------------------------------------------

/** Myers O(ND) line diff. `{ok: true, ins, del, d}`: `ins` the indexes of `b` that are inserted, `del` the indexes of `a`
 *  that are deleted. `{ok: false, reason: "large" | "many"}` above `maxLines` per side or `maxEdits` edits. The trace keeps
 *  one window of 2d+1 entries per step. */
export function myers(a, b, { maxLines = MAX_LINES, maxEdits = MAX_EDITS } = {}) {
  if (a.length > maxLines || b.length > maxLines) return { ok: false, reason: "large" };
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - lo, m = eb - lo;
  const ins = new Set(), del = new Set();
  if (n === 0 && m === 0) return { ok: true, ins, del, d: 0 };
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1)); // window k = -d..d at index k + d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return { ok: false, reason: "many" };
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const w = trace[d];
    const at = (k) => w[k + d];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    while (x > px && y > py) { x--; y--; }
    if (x === px) ins.add(lo + py); else del.add(lo + px);
    x = px; y = py;
  }
  return { ok: true, ins, del, d: found };
}

// ---- marks ---------------------------------------------------------------------------------------------------------

const normLine = (l) => l.replace(/\s+$/, "");

/** Lines of the block that count for marks: not blank, not a fence marker, not a table delimiter row. */
function countedLines(lines, block) {
  const skip = new Set(block.fenceMarkers);
  const out = [];
  for (let i = block.start; i < block.end; i++) {
    if (skip.has(i) || lines[i].trim() === "" || (block.kind === "text" && DELIM_ROW.test(lines[i]) && lines[i].includes("-"))) continue;
    out.push(i);
  }
  return out;
}

/** The snapshot a plan is compared with, from plan.json: "ruled" while the plan was edited after the ruling, "prev" when it
 *  equals the ruled version, null (no marks, no badge) when the snapshots belong to another path or a hash is missing. */
export function compareTarget(meta) {
  if (!isObj(meta) || typeof meta.path !== "string" || !meta.path || meta.ruledPath !== meta.path) return null;
  if (typeof meta.hash !== "string" || typeof meta.ruledHash !== "string" || !meta.ruledHash) return null;
  if (meta.hash !== meta.ruledHash) return "ruled";
  return typeof meta.prevHash === "string" && meta.prevHash ? "prev" : null;
}

/** Blocks of `text` with their mark against `base` (the compared snapshot, or null/undefined for none), and the line diff.
 *  Only the body above the first appendix heading is diffed and marked. Result `{lines, blocks, adds, note, diff}`: each
 *  block `{kind, start, end, mark: "new" | "changed" | null, text}`; `adds` counts marked blocks; `note` is "" or
 *  "too many changes for marks" / "Plan too large for marks (shown without)"; `diff` is the myers result or null. */
export function markBlocks(text, base) {
  const lines = toLines(text);
  const blocks = splitBlocks(lines).map((b) => ({ ...b, mark: null, text: lines.slice(b.start, b.end).join("\n") }));
  const res = { lines, blocks, adds: 0, note: "", diff: null };
  if (typeof base !== "string") return res;
  const baseLines = toLines(base);
  const cur = lines.slice(0, bodyEnd(lines)).map(normLine);
  const old = baseLines.slice(0, bodyEnd(baseLines)).map(normLine);
  const diff = myers(old, cur);
  res.diff = diff;
  if (!diff.ok) {
    res.note = diff.reason === "large" ? "Plan too large for marks (shown without)" : "too many changes for marks";
    return res;
  }
  const cut = cur.length;
  for (const b of res.blocks) {
    if (b.kind === "heading" || b.start >= cut) continue;
    const idx = countedLines(lines, b).filter((i) => i < cut);
    if (idx.length === 0) continue;
    const n = idx.filter((i) => diff.ins.has(i)).length;
    b.mark = n === idx.length ? "new" : n > 0 ? "changed" : null;
    if (b.mark) res.adds++;
  }
  return res;
}

// ---- Diff view -----------------------------------------------------------------------------------------------------

const headingText = (l) => (HEADING.test(l) ? l.replace(/^ {0,3}#{1,6}[ \t]*/, "").replace(/[ \t#]+$/, "") : null);

/** Hunks of the diff of `base` against `text` (bodies only) in the Changes-panel style: `[{heading, rows}]`, a row
 *  `{k: " " | "+" | "-", s}`; `ctx` unchanged lines around each change, nearby changes merge, `heading` is the last heading
 *  above the hunk. [] when there is nothing to show; null when the diff is not available. */
export function diffHunks(text, base, ctx = 2) {
  if (typeof base !== "string") return null;
  const bl = toLines(base), cl = toLines(text);
  const old = bl.slice(0, bodyEnd(bl)), cur = cl.slice(0, bodyEnd(cl));
  const diff = myers(old.map(normLine), cur.map(normLine));
  if (!diff.ok) return null;
  const rows = [];
  let i = 0, j = 0, head = "";
  while (i < old.length || j < cur.length) {
    if (i < old.length && diff.del.has(i)) { rows.push({ k: "-", s: old[i], head }); i++; continue; }
    if (j < cur.length && diff.ins.has(j)) { rows.push({ k: "+", s: cur[j], head }); j++; continue; }
    head = headingText(cur[j]) ?? head;
    rows.push({ k: " ", s: cur[j], head });
    i++; j++;
  }
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, n) => {
    if (r.k === " ") return;
    for (let x = Math.max(0, n - ctx); x <= Math.min(rows.length - 1, n + ctx); x++) keep[x] = true;
  });
  const hunks = [];
  let curHunk = null;
  rows.forEach((r, n) => {
    if (!keep[n]) { curHunk = null; return; }
    if (!curHunk) {
      // the heading in force before the hunk's first row: a heading row itself counts for its own hunk
      const above = n > 0 ? rows[n - 1].head : "";
      curHunk = { heading: headingText(r.s) ?? above, rows: [] };
      hunks.push(curHunk);
    }
    curHunk.rows.push({ k: r.k, s: r.s });
  });
  return hunks;
}

// ---- sanitiser -----------------------------------------------------------------------------------------------------

const ALLOWED_TAGS = new Set(["del", "br", "sub", "sup", "kbd"]);
const AUTOLINK = /^<https:\/\/[^\s<>]+>/;
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:[\s/][^<>]*)?\/?>/;

/** One line of prose (no fence) outside code spans: `![` escaped, HTML tags removed except the allow-list. `st.comment` carries
 *  an open `<!--` across lines. */
function cleanText(s, st) {
  const out = cleanRaw(s, st);
  // Without a link handler links must be inert: inline links become their text, autolinks a code span.
  return st.links ? out : out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<(https:\/\/[^\s<>]+)>/g, "`$1`");
}

function cleanRaw(s, st) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (st.comment) {
      const end = s.indexOf("-->", i);
      if (end < 0) return out;
      st.comment = false;
      i = end + 3;
      continue;
    }
    const c = s[i];
    if (c === "\\") { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === "!" && s[i + 1] === "[") { out += "!\\["; i += 2; continue; }
    if (c === "<") {
      if (st.hard) { out += "\\<"; i++; continue; } // the hard round only escapes: removing anything could rejoin `!` and `[`
      const rest = s.slice(i);
      if (rest.startsWith("<!--")) {
        const end = s.indexOf("-->", i + 4);
        if (end < 0) { st.comment = true; return out; }
        i = end + 3;
        continue;
      }
      const auto = AUTOLINK.exec(rest);
      if (auto) { out += auto[0]; i += auto[0].length; continue; }
      const tag = TAG.exec(rest);
      if (tag) {
        const name = tag[2].toLowerCase();
        if (name === "mark") {
          // the host draws <mark> as a yellow background under the theme's foreground: bold keeps the emphasis readable
          // \u0001 and \u0002 mark the span; sanitize turns them into asterisks once the whitespace is moved outside
          if (!tag[1]) { if (st.mark++ === 0) out += "\u0001"; } else if (st.mark > 0 && --st.mark === 0) out += "\u0002";
        } else if (ALLOWED_TAGS.has(name)) out += tag[1] ? `</${name}>` : `<${name}>`;
        i += tag[0].length;
        continue;
      }
      if (/^<[A-Za-z/!?]/.test(rest)) { out += "\\<"; i++; continue; } // an unfinished tag stays text
    }
    out += c;
    i++;
  }
  return out;
}

/** The markdown with every `![` escaped (also inside code spans and fences) and every HTML tag removed except del, br, sub, sup and kbd (attributes
 *  stripped); `<mark>text</mark>` becomes `**text**`; fences and inline code spans stay as written; `<https://...>` autolinks stay. */
export function sanitize(md, { links = true } = {}) {
  // Removing a tag can join the text around it into a new construct (`<<b>img ...>`): clean until nothing changes.
  let cur = sanitizeOnce(md, links, false);
  for (let round = 0; round < 8; round++) {
    const next = sanitizeOnce(cur, links, false);
    if (next === cur) return cur;
    cur = next;
  }
  return sanitizeOnce(cur, links, true); // still moving: escape every remaining `<` (and `![`) as text
}

function sanitizeOnce(md, links, hard) {
  const lines = toLines(md);
  const out = [];
  const st = { comment: false, links, mark: 0, hard };
  let open = null;
  let openIndent = 0;
  for (let line of lines) {
    line = line.replace(/[\u0001\u0002]/g, ""); // placeholder bytes never survive, in code spans and fences included
    if (open) {
      // A fence inside a list item ends where the item does: a text line indented less than the fence is outside it for
      // the renderer, so here it is prose again (never raw HTML kept as code).
      const leave = !fenceCloses(line, open) && openIndent > 0 && line.trim() !== "" && /^ */.exec(line)[0].length < openIndent;
      if (leave) open = null;
      else {
        out.push(line);
        if (fenceCloses(line, open)) open = null;
        continue;
      }
    }
    const f = st.comment ? null : fenceOpen(line);
    if (f) { open = f; openIndent = /^ */.exec(line)[0].length; out.push(line); continue; }
    out.push(cleanLine(line, st));
  }
  // fail-safe: no code-span or fence detection decides this one, so every `![` is escaped, code included
  return out.join("\n").replace(/(\\*)!\[/g, (m, b) => (b.length % 2 ? m : `${b}!\\[`)); // `\![` is already inert
}

/** The backtick runs of a line, found in one pass: `runs` is `[{at, len}]`, `byLen` maps a length to the sorted run indexes. */
function backtickRuns(line) {
  const runs = [];
  const byLen = new Map();
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 96) continue;
    let e = i;
    while (line.charCodeAt(e) === 96) e++;
    const list = byLen.get(e - i);
    if (list) list.push(runs.length); else byLen.set(e - i, [runs.length]);
    runs.push({ at: i, len: e - i });
    i = e - 1;
  }
  return { runs, byLen };
}

/** The first entry of the sorted `list` above `k`, or -1. */
function nextAbove(list, k) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] > k) hi = mid; else lo = mid + 1; }
  return lo < list.length ? list[lo] : -1;
}

/** One prose line: inline code spans stay as written, the rest goes through cleanText. A run of n backticks closes at the next
 *  run of n backticks on the line; a backtick after an odd number of backslashes is a literal character, not an opener. The runs
 *  are scanned once per line, so a long line of runs costs O(n log n), not O(n^2). */
function cleanLine(line, st) {
  const { runs, byLen } = backtickRuns(line);
  let res = "";
  let i = 0;
  let k = 0;
  while (i < line.length) {
    while (k < runs.length && runs[k].at < i) k++;
    if (k >= runs.length) { res += cleanText(line.slice(i), st); break; }
    let s = runs[k].at;
    let run = runs[k].len;
    let bs = 0;
    while (s - bs - 1 >= 0 && line[s - bs - 1] === "\\") bs++;
    if (bs % 2 === 1) { s++; run--; } // a backslash-escaped backtick is text
    if (run === 0) { res += cleanText(line.slice(i, s), st); i = s; k++; continue; }
    const j = byLen.has(run) ? nextAbove(byLen.get(run), k) : -1;
    if (j < 0) { res += cleanText(line.slice(i, s + run), st); i = s + run; k++; continue; }
    const close = runs[j].at;
    res += cleanText(line.slice(i, s), st) + line.slice(s, close + run);
    i = close + run;
    k = j + 1;
  }
  if (st.mark > 0) { res += "\u0002"; st.mark = 0; } // an unclosed <mark> ends with its line
  return res.replace(/\u0001([^\u0002]*)\u0002/g, (_, t) => {
    const b = t.trim();
    return b ? `${t.slice(0, t.length - t.trimStart().length)}**${b}**${t.slice(t.trimEnd().length)}` : t;
  });
}

// ---- anchor --------------------------------------------------------------------------------------------------------

/** The agent terminal that owns the tab the window shows: among the agents with a pane in `focus.tab`, the one on the
 *  focused pane, else `prev` while it is still one of them, else the first. A floating or peek window has no pane in the tab
 *  (`focus.pane` is null) and never moves the anchor. null when the tab has none. */
export function anchorAgent(agents, panes, focus, prev = null) {
  if (!isObj(focus) || typeof focus.tab !== "string") return null;
  const paneIn = Array.isArray(panes) ? new Set(panes.filter((p) => p?.tab === focus.tab).map((p) => p.pane)) : null;
  const own = (Array.isArray(agents) ? agents : []).filter((a) => typeof a?.address === "string" && a.tab === focus.tab
    && typeof a.pane === "string" && a.pane && (!paneIn || paneIn.has(a.pane)));
  return (own.find((a) => a.pane === focus.pane) ?? own.find((a) => a.address === prev) ?? own[0] ?? null)?.address ?? null;
}

/** Sessions below `node` (depth first, by radar `parent`) that publish a plan or a note: `[{node, label}]`. */
export function childPlans(node) {
  return allSessions(node ? [node] : []).slice(1).filter((n) => planHint(n) !== null || noteHint(n) !== null).map((n) => ({ node: n, label: n.name || n.key }));
}

/** The `show.plan` version hint of a session node, or null. */
export function planHint(n) {
  return Number.isInteger(n?.show?.plan) ? n.show.plan : null;
}

export function noteHint(n) {
  return Number.isInteger(n?.show?.note) ? n.show.note : null;
}

/** The part a child tab shows: the picked one ("plan" | "note") when the session has it, else plan when it has one, else note. */
export function partFor(n, picked) {
  const has = { plan: planHint(n) !== null, note: noteHint(n) !== null };
  if (picked && has[picked]) return picked;
  return has.plan ? "plan" : "note";
}

/** True when a session has a part (plan or note) whose radar version is above the version last shown of it: `seenOf(part)`
 *  gives that version, undefined when the part was never shown (it counts as unseen). */
export function hasUnseen(n, seenOf) {
  return partUnseen(n, "plan", seenOf) || partUnseen(n, "note", seenOf);
}

/** True when the given part of a session exists and its radar version is above the one last shown of it. */
export function partUnseen(n, part, seenOf) {
  const v = part === "note" ? noteHint(n) : planHint(n);
  return v !== null && (seenOf(part) === undefined || v > seenOf(part));
}

/** The ● dot of a child tab label: only while the tab is not the one on screen and one of its parts has unseen content. */
export function tabDot(n, onScreen, seenOf) {
  return !onScreen && hasUnseen(n, seenOf);
}

/** The ● dot of a Plan | Note switch button: the part has unseen content and is not the part on screen. */
export function partDot(n, part, shownPart, seenOf) {
  return part !== shownPart && partUnseen(n, part, seenOf);
}

/** The folder of a file path (either separator); "" for a bare name. */
export function dirOf(p) {
  return String(p).replace(/[\\/][^\\/]*$/, "");
}

/** plan.json / note.json text to a checked record, or null. Strings are length-capped; `fences` is a list of strings. */
export function parseMeta(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!isObj(d)) return null;
  const s = (v, max = 4096) => (typeof v === "string" && v.length <= max ? v : "");
  return {
    path: typeof d.path === "string" && d.path.length <= 4096 ? d.path : null,
    title: s(d.title, 300), v: Number.isInteger(d.v) ? d.v : 0, at: Number.isFinite(Date.parse(d.at)) ? Date.parse(d.at) : null,
    hash: s(d.hash, 128), ruledPath: typeof d.ruledPath === "string" ? s(d.ruledPath) : null, ruledHash: s(d.ruledHash, 128),
    prevHash: s(d.prevHash, 128), fences: Array.isArray(d.fences) ? d.fences.filter((f) => typeof f === "string").slice(0, 64) : [],
    diagrams: checkDiagrams(d.diagrams),
  };
}

/** A document path from plan.json that the panel may read: absolute, a `.md` file name. */
export function isReadablePath(p) {
  return typeof p === "string" && /\.md$/i.test(p) && /^(?:[A-Za-z]:)?[\\/]/.test(p) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
}

/** True for a light theme: the luminance of `#rrggbb` is above one half. */
export function isLight(bg) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(bg));
  if (!m) return false;
  return (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255 > 0.5;
}

// ---- code fences, diagrams -----------------------------------------------------------------------------------------

const LANG_ALIAS = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", sh: "bash", zsh: "bash", shell: "bash", yml: "yaml", rs: "rust", md: "markdown" };

/** The language of a fence info string: its first word, lower-cased, common aliases mapped; "" (plain) when empty or no plain identifier. */
export function fenceLang(info) {
  const w = String(info ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (!/^[a-z0-9_+#-]{1,24}$/.test(w)) return "";
  return LANG_ALIAS[w] ?? w;
}

const U32 = 0x100000000;
const primes = (n) => {
  const out = [];
  for (let c = 2; out.length < n; c++) if (out.every((p) => c % p !== 0)) out.push(c);
  return out;
};
const K256 = primes(64).map((p) => Math.floor((Math.cbrt(p) % 1) * U32) >>> 0);
const H256 = primes(8).map((p) => Math.floor((Math.sqrt(p) % 1) * U32) >>> 0);

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, as TextEncoder does). */
export function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    } else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** sha256 of the UTF-8 bytes of `s`, lower-case hex (pure JS: the herdr-app runtime has no hashing API). */
export function sha256(s) {
  const bytes = utf8(String(s));
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (const x of [Math.floor(bits / U32), bits >>> 0]) bytes.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  const h = H256.slice();
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let p = 0; p < bytes.length; p += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((bytes[p + 4 * i] << 24) | (bytes[p + 4 * i + 1] << 16) | (bytes[p + 4 * i + 2] << 8) | bytes[p + 4 * i + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + add[i]) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** What a fence block holds: `{text, lang, closed, mermaid, sha}`. `text` is the inner lines joined by LF; a mermaid fence (shared
 *  rule with the harness, tests/fixtures/mermaid-fences.json) opens and closes at column 0, `mermaid` is the first info word;
 *  `sha` is the sha256 of its text, null otherwise. */
export function fenceInfo(lines, block) {
  const closed = block.fenceMarkers.length === 2;
  const text = lines.slice(block.start + 1, closed ? block.end - 1 : block.end).join("\n");
  const col0 = (l) => /^(?:`{3,}|~{3,})/.test(l ?? "");
  const mermaid = closed && col0(lines[block.start]) && col0(lines[block.end - 1]) && String(block.info ?? "").trim().split(/\s+/)[0] === "mermaid";
  return { text, lang: fenceLang(block.info), closed, mermaid, sha: mermaid ? sha256(text) : null };
}

const SVG_MAX_BYTES = 512 * 1024;
const SVG_ALLOWED = new Set(["svg", "g", "rect", "path", "text", "tspan", "line", "polyline", "polygon", "circle", "ellipse", "marker", "defs"]);
const MARKER_REF = /\bmarker-(?:start|mid|end)="url\(#[A-Za-z0-9_-]+\)"/g;

/** The allow-list check of a diagram SVG (the harness runs the same before it writes): null when fine, else the reason. */
export function validateSvg(svg) {
  if (typeof svg !== "string") return "not_text";
  if (utf8(svg).length > SVG_MAX_BYTES) return "too_large";
  if (!/^\s*<svg[\s>]/.test(svg)) return "not_svg";
  if (/<!|<\?/.test(svg)) return "declaration";
  if (/foreignObject|<script/i.test(svg)) return "active_content";
  if (/\bhref\s*=/i.test(svg)) return "href";
  if (/\bon[a-z]+\s*=/i.test(svg)) return "event_attribute";
  if (/url\(/i.test(svg.replace(MARKER_REF, ""))) return "url";
  if (/var\(/i.test(svg)) return "var";
  if (/@import|color-mix\(|javascript:/i.test(svg)) return "unsupported";
  for (const m of svg.matchAll(/<\/?\s*([A-Za-z][\w:-]*)/g)) if (!SVG_ALLOWED.has(m[1])) return `element:${m[1].slice(0, 20)}`;
  return null;
}

/** `{w, h}` from the root element's width and height attributes (clamped to 40..4000), or null. */
export function svgSize(svg) {
  const tag = /^\s*<svg\b[^>]*>/.exec(String(svg))?.[0] ?? "";
  const w = Number(/\swidth="([\d.]+)"/.exec(tag)?.[1]);
  const h = Number(/\sheight="([\d.]+)"/.exec(tag)?.[1]);
  if (!(w > 0) || !(h > 0)) return null;
  return { w: Math.min(4000, Math.max(40, w)), h: Math.min(4000, Math.max(40, h)) };
}

/** A diagrams list from plan.json / note.json to the checked entries `{sha, dark, light}`: sha is 64 hex and both paths are exactly
 *  `diagrams/<sha>-dark.svg` / `-light.svg` (relative, no `..`). At most 32. */
export function checkDiagrams(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!isObj(d) || typeof d.sha !== "string" || !/^[0-9a-f]{64}$/.test(d.sha)) continue;
    if (d.dark !== `diagrams/${d.sha}-dark.svg` || d.light !== `diagrams/${d.sha}-light.svg`) continue;
    out.push({ sha: d.sha, dark: d.dark, light: d.light });
    if (out.length >= 32) break;
  }
  return out;
}

/** Where the panel block of `mod` sits in a layout tree: `{stack, show}` ids to pass to layout.select (the stack and the block)
 *  and layout.show (the hidden ancestor, else the stack's parent), or null when the tree has no such block. */
export function findPanelBlock(tree, mod) {
  const walk = (n, chain) => {
    if (!isObj(n)) return null;
    const here = [...chain, n];
    if (n.type === "block" && isObj(n.content) && n.content.mod === mod) return { block: n, chain };
    for (const c of Array.isArray(n.children) ? n.children : []) {
      const hit = walk(c, here);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(tree, []);
  if (!hit || typeof hit.block.id !== "string") return null;
  const up = [...hit.chain].reverse();
  const si = up.findIndex((n) => n.type === "stack" && typeof n.id === "string");
  const stack = si >= 0 ? up[si] : null;
  const hidden = up.find((n) => n.hidden === true && typeof n.id === "string");
  const show = hidden ?? (si >= 0 ? up.slice(si + 1).find((n) => typeof n.id === "string") : null) ?? null;
  return { block: hit.block.id, stack: stack?.id ?? null, show: show?.id ?? null };
}

/** The app-home relative cache path of a diagram, or null for a bad sha or theme. */
export function cachePath(sha, theme) {
  return /^[0-9a-f]{64}$/.test(sha) && (theme === "dark" || theme === "light") ? `mods/pi-foreman-plan/cache/${sha}-${theme}.svg` : null;
}
