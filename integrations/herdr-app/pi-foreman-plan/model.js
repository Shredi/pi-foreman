// Model layer of the pi-foreman-plan herdr-app mod: pure functions, no herdr import, no I/O, ESM.
// The page index (pages.json) reader, the page-opener argv, the relative-URL rewrite of a page copy, unseen marks, anchor resolution.
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

// ---- the page index ------------------------------------------------------------------------------------------------

/** The only page file names the panel builds a path from. */
export const PAGE_FILE = /^(?:plan|result|note-\d{1,6})\.html$/;
export const MAX_PAGES = 40;
export const MAX_EVENTS = 50;
/** The largest page text the panel reads (the host reads at most 1 MiB). */
export const MAX_PAGE_CHARS = 1024 * 1024;

const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max) : "");
const kindOfFile = (file) => (file.startsWith("plan") ? "plan" : file.startsWith("result") ? "result" : "note");

/** pages.json text to `{pages, events}`, or null when it is not an index. A page entry is kept only when its `file` matches
 *  PAGE_FILE (any other entry is dropped before a path can be built); id and kind come from the file name, never from the entry.
 *  Pages come newest first (`at`, then version); a page `{id, kind, file, title, state, version, at}` has `at` in ms or null;
 *  an event `{at, kind, text}` keeps the file order (oldest first). */
export function parsePages(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!isObj(d) || d.v !== 1 || !Array.isArray(d.pages)) return null;
  const when = (v) => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  const seen = new Set();
  const pages = [];
  for (const p of d.pages.slice(0, 200)) {
    if (!isObj(p) || typeof p.file !== "string" || !PAGE_FILE.test(p.file)) continue;
    const id = p.file.slice(0, -".html".length);
    if (seen.has(id)) continue;
    seen.add(id);
    pages.push({ id, kind: kindOfFile(p.file), file: p.file, title: clean(p.title, 120), state: clean(p.state, 40), version: Number.isInteger(p.version) && p.version >= 0 ? p.version : 0, at: when(p.at) });
  }
  pages.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.version - a.version);
  const events = [];
  for (const e of Array.isArray(d.events) ? d.events.slice(-MAX_EVENTS) : []) {
    if (!isObj(e) || typeof e.text !== "string") continue;
    events.push({ at: when(e.at), kind: clean(e.kind, 40), text: clean(e.text, 200) });
  }
  return { pages: pages.slice(0, MAX_PAGES), events };
}

/** The chip of a page: "plan v3 · waits for you" (a result has no version). */
export function chipText(p) {
  return `${p.kind}${p.kind === "result" ? "" : ` v${p.version}`}${p.state ? ` · ${p.state}` : ""}`;
}

/** What identifies the shown state of a page for the unseen dot. */
export const pageStamp = (p) => `${p.at ?? ""}|${p.version}|${p.state}`;

/** True when a page is not seen at its current stamp: `seenOf(id)` is the stamp last opened, undefined when never. */
export const pageUnseen = (p, seenOf) => seenOf(p.id) !== pageStamp(p);

/** True when any page of a list is unseen. */
export const hasUnseen = (pages, seenOf) => Array.isArray(pages) && pages.some((p) => pageUnseen(p, seenOf));

/** The ● dot of a tab label: only while the tab is not on screen and one of its pages is unseen. */
export function tabDot(pages, onScreen, seenOf) {
  return !onScreen && hasUnseen(pages, seenOf);
}

/** True when `next` holds a page that `prev` (a Map id -> `version`) did not: a new id or a higher version. */
export function newPage(prev, pages) {
  return pages.some((p) => !prev.has(p.id) || p.version > prev.get(p.id));
}

// ---- opening a page ------------------------------------------------------------------------------------------------

export const SLOTS = 8;
const SLOT_DIR = ["mods", "pi-foreman-plan", "cache", "pages"];

/** `<appHome>/mods/pi-foreman-plan/cache/pages/slot-<n>.html` in the separator of `appHome`, or null for a bad home or slot. */
export function slotPath(appHome, n) {
  if (typeof appHome !== "string" || !appHome || !Number.isInteger(n) || n < 0 || n >= SLOTS) return null;
  const sep = appHome.includes("\\") && !appHome.includes("/") ? "\\" : "/";
  return [appHome.replace(/[\\/]+$/, ""), ...SLOT_DIR, `slot-${n}.html`].join(sep);
}

/** The platform opener for a page copy: argv `open` / `xdg-open` / `rundll32 url.dll,FileProtocolHandler`, no shell. Only the exact
 *  path of one of the eight slots below `appHome` is accepted (case-insensitive on macOS and Windows, where `\` and `/` are the
 *  same on Windows); anything else, a relative or `..` home included, answers null. */
export function pageOpenerArgv(platform, appHome, copyPath) {
  if (typeof appHome !== "string" || typeof copyPath !== "string" || copyPath.length > 4096) return null;
  if (!/^(?:[A-Za-z]:)?[\\/]/.test(appHome) || /[\u0000-\u001f]/.test(appHome) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(appHome)) return null;
  const norm = (s) => {
    const a = platform === "win32" ? s.replace(/\\/g, "/") : s;
    return platform === "darwin" || platform === "win32" ? a.toLowerCase() : a;
  };
  let hit = false;
  for (let n = 0; n < SLOTS && !hit; n++) hit = norm(slotPath(appHome, n)) === norm(copyPath);
  if (!hit) return null;
  if (platform === "darwin") return ["open", copyPath];
  if (platform === "linux") return ["xdg-open", copyPath];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", copyPath];
  return null;
}

/** The `file://` URL of a folder, with a trailing slash, every path segment percent-encoded; null for a folder that is not absolute. */
export function dirFileUrl(dir) {
  try {
    const d = String(dir);
    const win = /^[A-Za-z]:[\\/]/.test(d) || (d.includes("\\") && !d.includes("/"));
    const p = (win ? d.replace(/\\/g, "/") : d).replace(/\/+$/, "");
    if (!/^(?:[A-Za-z]:)?\//.test(p)) return null;
    const seg = (s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s).replace(/'/g, "%27"));
    return `file://${p.startsWith("/") ? "" : "/"}${p.split("/").map(seg).join("/")}/`;
  } catch { return null; }
}

const REL_ATTR = /([\s"'/]|^)(src|poster)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
// One code point at a time (`u`); a lone surrogate cannot be encoded and becomes U+FFFD.
const encodePoint = (c) => { try { return encodeURIComponent(c).replace(/'/g, "%27"); } catch { return "%EF%BF%BD"; } };
const percent = (v) => v.replace(/%(?![0-9A-Fa-f]{2})/g, "%25").replace(/[^A-Za-z0-9\-._~!$&()*+,;=:@/?#%]/gu, encodePoint);

/** `html` with every relative `src` and `poster` attribute value (quoted; no scheme, not starting with `/` or `#`) made absolute
 *  against `base` (a `file://` folder URL ending in `/`). Links, `#` anchors, absolute and scheme values, `srcset`, `<link href>` and
 *  CSS `url()` stay as they are. */
export function rewriteRelative(html, base) {
  return String(html).replace(REL_ATTR, (m, pre, name, eq, dq, sq) => {
    const v = dq ?? sq;
    const t = v.trim();
    if (t === "" || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) || /^[\\/#]/.test(t)) return m;
    const q = dq !== undefined ? '"' : "'";
    return `${pre}${name}${eq}${q}${base}${percent(t)}${q}`;
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

/** Sessions below `node` (depth first, by radar `parent`) that have a show folder: `[{node, label}]`. */
export function childPlans(node) {
  return allSessions(node ? [node] : []).slice(1).filter((n) => typeof n?.show?.dir === "string" && n.show.dir).map((n) => ({ node: n, label: n.name || n.key }));
}

/** The folder of a file path (either separator); "" for a bare name. */
export function dirOf(p) {
  return String(p).replace(/[\\/][^\\/]*$/, "");
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
