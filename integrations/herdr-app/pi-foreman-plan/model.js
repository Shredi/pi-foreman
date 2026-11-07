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
          if (!tag[1]) { if (st.mark++ === 0) out += "**"; } else if (st.mark > 0 && --st.mark === 0) out += "**";
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

/** The markdown with every `![` escaped and every HTML tag removed except del, br, sub, sup and kbd (attributes
 *  stripped); `<mark>text</mark>` becomes `**text**`; fences and inline code spans stay as written; `<https://...>` autolinks stay. */
export function sanitize(md, { links = true } = {}) {
  const lines = toLines(md);
  const out = [];
  const st = { comment: false, links, mark: 0 };
  let open = null;
  for (const line of lines) {
    if (open) {
      out.push(line);
      if (fenceCloses(line, open)) open = null;
      continue;
    }
    const f = st.comment ? null : fenceOpen(line);
    if (f) { open = f; out.push(line); continue; }
    // split off inline code spans: a run of n backticks closes at the next run of n backticks on the line
    let res = "";
    let i = 0;
    while (i < line.length) {
      const m = /`+/.exec(line.slice(i));
      if (!m) { res += cleanText(line.slice(i), st); break; }
      const s = i + m.index;
      const run = m[0].length;
      let close = -1;
      for (let p = s + run; p < line.length;) {
        const q = line.indexOf("`", p);
        if (q < 0) break;
        let e = q;
        while (line[e] === "`") e++;
        if (e - q === run) { close = q; break; }
        p = e;
      }
      if (close < 0) { res += cleanText(line.slice(i, s + run), st); i = s + run; continue; }
      res += cleanText(line.slice(i, s), st) + line.slice(s, close + run);
      i = close + run;
    }
    if (st.mark > 0) { res += "**"; st.mark = 0; } // an unclosed <mark> ends with its line
    out.push(res);
  }
  return out.join("\n");
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

/** Sessions below `node` (depth first, by radar `parent`) that publish a plan: `[{node, label}]`. */
export function childPlans(node) {
  return allSessions(node ? [node] : []).slice(1).filter((n) => planHint(n) !== null).map((n) => ({ node: n, label: n.name || n.key }));
}

/** The `show.plan` version hint of a session node, or null. */
export function planHint(n) {
  return Number.isInteger(n?.show?.plan) ? n.show.plan : null;
}

export function noteHint(n) {
  return Number.isInteger(n?.show?.note) ? n.show.note : null;
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
