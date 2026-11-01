// Model layer of the pi-foreman herdr-app mod: pure functions over `foreman radar --json` output.
// No herdr import, no I/O, ESM. Every function accepts bad input and answers with an empty value; none throws.

const MAX_DEPTH = 40;
const MAX_NODES = 2000;
const INLINE_MAX = 2;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const int = (v) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---- URLs and the opener -------------------------------------------------------------------------------------

// https only, then URL characters only: no whitespace, no & | ^ < > " ' backtick backslash, no control characters.
const SAFE_URL = /^https:\/\/[A-Za-z0-9][A-Za-z0-9\-._~:/?#[\]@!$()*+,;=%]*$/;

export function isSafeHttpsUrl(url) {
  return typeof url === "string" && url.length <= 2048 && SAFE_URL.test(url);
}

/** The argv that opens `url` with the platform opener; never through cmd or a shell. null for an unsafe URL or an unknown platform. */
export function openerArgv(platform, url) {
  if (!isSafeHttpsUrl(url)) return null;
  if (platform === "darwin") return ["open", url];
  if (platform === "linux") return ["xdg-open", url];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  return null;
}

/** The foreman binary for a machine from the `foreman` prop: a string (local only) or an object keyed by machine name
 *  (`local` for this computer). A missing entry is plain `foreman`. */
export function radarBinary(prop, machine, fallback = "foreman") {
  if (typeof prop === "string" && prop.trim() && !machine) return prop.trim();
  if (isObj(prop)) {
    const v = prop[machine || "local"];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
}

// ---- parse ---------------------------------------------------------------------------------------------------

const CHECK = { fail: "fail", run: "pending", ok: "ok", none: "none" };
const MERGEABLE = ["MERGEABLE", "CONFLICTING", "UNKNOWN"];

// Fields a PR may carry beyond its checks: the radar `openPrs` entry has them; `baseRefName` is read from that entry only.
const prExtras = (p) => ({
  title: str(p.title), bodyText: str(p.bodyText), branch: str(p.headRefName),
  baseRef: str(p.baseRefName), mergeable: MERGEABLE.includes(p.mergeable) ? p.mergeable : "",
});

function cleanRepoUrl(v) {
  const s = str(v).replace(/\.git$/, "").replace(/\/+$/, "");
  return isSafeHttpsUrl(s) && !/[?#]/.test(s) ? s : "";
}

function normDots(raw, repoUrl) {
  const byN = new Map();
  if (!Array.isArray(raw)) return [];
  for (const d of raw) {
    if (!isObj(d) || d.src !== "pr" || int(d.n) === null || !(d.state in CHECK)) continue;
    let pr = byN.get(d.n);
    if (!pr) {
      pr = { number: d.n, checks: [], jobs: [], url: "", repo: "", ...prExtras(d) };
      byN.set(d.n, pr);
    }
    pr.checks.push(CHECK[d.state]);
    pr.jobs.push({ name: str(d.name), state: CHECK[d.state] });
    if (!pr.url && isSafeHttpsUrl(d.url)) pr.url = d.url;
    if (!pr.repo) pr.repo = cleanRepoUrl(d.repo) || repoUrl;
  }
  return [...byN.values()];
}

function normNode(raw, depth, budget) {
  if (!isObj(raw) || depth > MAX_DEPTH || budget.left-- <= 0) return null;
  const repoUrl = cleanRepoUrl(raw.repoUrl) || cleanRepoUrl(raw.repo);
  const waits = Array.isArray(raw.waits) ? raw.waits.filter(isObj).map((w) => ({
    kind: str(w.kind), note: str(w.note), ageS: num(w.age_s),
  })) : [];
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(isObj).map((t) => ({ label: str(t.label), ageS: num(t.ageSeconds) })) : [];
  const asks = Array.isArray(raw.asks) ? raw.asks.filter((a) => isObj(a) && int(a.n) !== null).map((a) => ({ n: a.n, topic: str(a.topic) })) : [];
  const own = isObj(raw.own) ? num(raw.own.cost) : 0;
  const children = [];
  if (Array.isArray(raw.children)) {
    for (const c of raw.children) {
      const n = normNode(c, depth + 1, budget);
      if (n) children.push(n);
    }
  }
  return {
    key: str(raw.key), kind: str(raw.kind) || "session", name: str(raw.name), role: str(raw.role), rung: str(raw.rung),
    tier: str(raw.tier), model: str(raw.model), state: str(raw.state), glyph: str(raw.glyph), sym: str(raw.sym),
    hcTerminal: str(raw.hcTerminal), pid: int(raw.pid), machine: str(raw.machine), parent: str(raw.parent),
    blockedS: int(raw.blocked_s), ended: raw.ended_s !== null && raw.ended_s !== undefined,
    cost: own, waits, tasks, asks, prs: normDots(raw.dots, repoUrl), repoUrl, children,
    repo: nameOf(raw.repo), branch: str(raw.branch),
  };
}

const STATE_ALIAS = { pending: "run", running: "run", in_progress: "run", queued: "run", success: "ok", passed: "ok", pass: "ok", failure: "fail", failed: "fail", error: "fail" };

/** One check of a feed entry in either shape: a state string ("ok") or an object {n|name, state, label}. null when it has no known state. */
export function jobOf(c) {
  const raw = isObj(c) ? c.state : c;
  const key = typeof raw === "string" ? raw.toLowerCase() : "";
  const state = CHECK[STATE_ALIAS[key] ?? key];
  if (!state) return null;
  return { name: isObj(c) ? str(c.n) || str(c.name) || str(c.label) : "", state };
}

function normOpenPrs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw.slice(0, 200)) {
    if (!isObj(p) || int(p.number) === null) continue;
    const jobs = (Array.isArray(p.checks) ? p.checks : Array.isArray(p.jobs) ? p.jobs : []).map(jobOf).filter(Boolean);
    out.push({
      number: p.number, checks: jobs.map((j) => j.state), jobs, url: isSafeHttpsUrl(p.url) ? p.url : "", repo: str(p.repo),
      state: str(p.state), ...prExtras(p),
    });
  }
  return out;
}

/** Puts each open feed PR on the sessions with the same repository and head branch (`node.repo`, `node.branch` from the live
 *  file); a PR already on the node (same number) is not added twice. Mutates the nodes `parseRadarDoc` just built. */
export function matchPrs(nodes, feed, depth = 0) {
  if (depth > MAX_DEPTH) return;
  for (const n of listOf(nodes)) {
    if (!isObj(n)) continue;
    if (n.kind === "session" && n.repo && n.branch) {
      const repo = n.repo.toLowerCase();
      for (const p of listOf(feed)) {
        if (!isObj(p) || p.state === "merged" || p.state === "closed" || p.branch !== n.branch || nameOf(p.repo).toLowerCase() !== repo) continue;
        if (!n.prs.some((x) => x.number === p.number && (!x.repo || !p.repo || nameOf(x.repo) === nameOf(p.repo)))) n.prs.push({ ...p });
      }
    }
    matchPrs(n.children, feed, depth + 1);
  }
}

/** `{nodes, openPrs}` from the text of `foreman radar --json`, or null when the text is not a radar document. */
export function parseRadarDoc(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!isObj(doc) || !Array.isArray(doc.roots)) return null;
  const budget = { left: MAX_NODES };
  const nodes = doc.roots.map((r) => normNode(r, 0, budget)).filter(Boolean);
  const at = typeof doc.openPrsAt === "string" ? Date.parse(doc.openPrsAt) : NaN;
  const openPrs = normOpenPrs(doc.openPrs);
  matchPrs(nodes, openPrs);
  return { nodes, openPrs, ...(Number.isFinite(at) ? { openPrsAt: at } : {}) };
}

/** The root nodes of the radar document, normalized; [] for anything else. */
export function parseRadar(text) {
  return parseRadarDoc(text)?.nodes ?? [];
}

// ---- tree ----------------------------------------------------------------------------------------------------

/** Fresh node copies with `sessions` and `workers` lists. A `parent` key that names another node in the set links it
 *  there (radar nests children already); top-most sessions are the session nodes that have no parent. Returns them. */
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

/** Every session node of the trees, depth first. */
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

const pidOf = (a) => int(a?.pid) ?? int(a?.foreground?.pid);

/** Map agent address -> session node. Join on `hcTerminal` == the agent's terminal address (`machine/` prefix for an agent of
 *  a remote space: pass that machine), only nodes that are not done and not themselves remote; when both sides have a pid
 *  they must match. */
export function joinAgents(agents, tree, machine = null) {
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
  return out;
}

/** Map pane-less child terminal address -> session node. `kids` are terminal records (`hc ls`), joined like agents on
 *  `hcTerminal` == the address (`machine/` prefix: pass that machine). Nodes in `taken` (already shown under a paned agent) are
 *  not used; a node joins one terminal only. */
export function joinChildren(kids, tree, machine = null, taken = new Set()) {
  const out = new Map();
  const used = new Set(taken);
  for (const [addr, n] of joinAgents(kids, tree, machine)) {
    if (used.has(n)) continue;
    used.add(n);
    out.set(addr, n);
  }
  return out;
}

// ---- rows ----------------------------------------------------------------------------------------------------

/** Cost as the TUI sidebar prints it. */
export function fmtCost(c) {
  const v = num(c);
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

export function fmtAge(s) {
  const v = Math.max(0, Math.floor(num(s)));
  if (v < 60) return `${v}s`;
  if (v < 3600) return `${Math.floor(v / 60)}m`;
  if (v < 86400) return `${Math.floor(v / 3600)}h`;
  return `${Math.floor(v / 86400)}d`;
}

/** A gap in milliseconds as "<1m", minutes, hours or days. */
export function fmtSince(ms) {
  const mins = Math.floor(Math.max(0, num(ms)) / 60000);
  const steps = [[1440, "d"], [60, "h"], [1, "m"]];
  const hit = steps.find(([size]) => mins >= size);
  return hit ? `${Math.floor(mins / hit[0])}${hit[1]}` : "<1m";
}

/** Status shown for an hc child terminal: the agent list wins over the terminal's own status. */
export function workerStatus(own, listed) {
  const map = { error: "blocked", done: "idle" };
  const s = listed ?? own;
  return map[s] ?? s;
}

const GLYPHS = {
  working: { kind: "spin", tone: "working", hollow: false },
  blocked: { kind: "pill", tone: "blocked", hollow: false },
  idle: { kind: "dot", tone: "idle", hollow: true },
  done: { kind: "dot", tone: "done", hollow: false },
  agents: { kind: "spin", tone: "working", hollow: true, ms: 1800 },
  bg: { kind: "square", tone: "working", hollow: false },
  waiting: { kind: "dot", tone: "muted", hollow: true },
};

/** How a status is drawn: {kind: "spin"|"pill"|"dot", tone: theme colour name, hollow}; unknown statuses are a dim filled dot. */
export function glyphSpec(status) {
  const hit = typeof status === "string" && Object.hasOwn(GLYPHS, status) ? GLYPHS[status] : null;
  return { ...(hit ?? { kind: "dot", tone: "dim", hollow: false }) };
}

/** Live hc children below an address as flat rows {term, depth, last}; last[i] is true when the ancestor at level i was the final sibling. */
export function childTerminals(all, address) {
  if (!Array.isArray(all)) return [];
  const out = [];
  const seen = new Set([address]);
  const walk = (parent, last) => {
    const kids = all.filter((k) => isObj(k) && k.parent === parent && k.state === "live");
    kids.forEach((term, i) => {
      if (seen.has(term.address)) return;
      seen.add(term.address);
      const flags = [...last, i === kids.length - 1];
      out.push({ term, depth: flags.length, last: flags });
      walk(term.address, flags);
    });
  };
  walk(address, []);
  return out;
}

/** Colours of the PR dot fill and the card groups from a theme `t`. Green is the ANSI green (the theme `done` is blue), amber the ANSI yellow. */
export function prTones(t) {
  return { green: t.ansi2 ?? t.ansi10 ?? t.done ?? t.working, red: t.blocked, amber: t.ansi3 ?? t.ansi11 ?? t.working, dim: t.dim };
}

/** Colour role of a PR check dot: green ok, red fail, amber (warning) pending, dim otherwise. */
export function checkTone(state) {
  return state === "ok" ? "ok" : state === "fail" ? "fail" : state === "pending" ? "warning" : "dim";
}

export function shortModel(m) {
  return str(m).replace(/^.*\//, "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Own cost plus every nested session's. */
export function totalCost(node) {
  let sum = 0;
  for (const s of allSessions([node])) sum += num(s.cost);
  return sum;
}

export function sessionCount(node) {
  return allSessions([node]).length;
}

const urgency = (pr) => {
  const s = (Array.isArray(pr.checks) ? pr.checks : []).map(jobOf).filter(Boolean).map((j) => j.state);
  return s.includes("fail") ? 0 : s.includes("pending") ? 1 : 2;
};

/** Failing first, then pending, then green; newest (highest number) first inside each. */
export function sortPrs(prs) {
  return (Array.isArray(prs) ? prs.filter(isObj) : [])
    .slice().sort((a, b) => urgency(a) - urgency(b) || num(b.number) - num(a.number));
}

/** "N PRs · k failing · m pending", or "N PRs · all green"; "" for none. */
export function prSummary(prs) {
  const list = Array.isArray(prs) ? prs.filter(isObj) : [];
  if (!list.length) return "";
  const failing = list.filter((p) => urgency(p) === 0).length;
  const pending = list.filter((p) => urgency(p) === 1).length;
  const parts = [failing && `${failing} failing`, pending && `${pending} pending`].filter(Boolean);
  return `${list.length} PR${list.length === 1 ? "" : "s"} · ${parts.join(" · ") || "all green"}`;
}

/** Up to INLINE_MAX chips sit on a session row; more go on a line below. */
export function splitPrs(prs) {
  const s = sortPrs(prs);
  return s.length > INLINE_MAX ? { inline: [], below: s } : { inline: s, below: [] };
}

/** The page of a PR: its own URL, else `<https repository URL>/pull/<number>`; "" when radar gives neither (not clickable). */
export function prUrl(node, pr) {
  if (!isObj(pr)) return "";
  if (isSafeHttpsUrl(pr.url)) return pr.url;
  const base = cleanRepoUrl(pr.repo) || cleanRepoUrl(node?.repoUrl);
  const n = int(pr.number);
  if (!base || n === null || n < 0) return "";
  const url = `${base}/pull/${n}`;
  return isSafeHttpsUrl(url) ? url : "";
}

const listOf = (x) => (Array.isArray(x) ? x : []);
const radarRuns = (n) => listOf(n?.children).filter((c) => c.kind === "run" && !c.ended && c.state === "working").map((c) => c.role || c.name);

/** The running async agents from the text of `hc get <terminal> --json`: `[{title, state}]` of the `pi-subagents` child
 *  records in state working or blocked; [] for anything else. */
export function parseRecords(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  if (!isObj(doc)) return [];
  // Real `hc get --json`: an object keyed by record id; an array is accepted too.
  const rows = Array.isArray(doc.records) ? doc.records : isObj(doc.records) ? Object.entries(doc.records).map(([id, r]) => (isObj(r) ? { id, ...r } : r)) : [];
  return rows
    .filter((r) => isObj(r) && r.app === "pi-subagents" && (r.state === "working" || r.state === "blocked"))
    .slice(0, 50).map((r) => ({ title: str(r.title), state: r.state, msg: str(r.msg) }));
}

// Records radar does not show already: each working radar run cancels one record with the same title.
function extraRecords(n, recs) {
  const left = new Map();
  for (const t of radarRuns(n)) left.set(t, (left.get(t) ?? 0) + 1);
  return listOf(recs).filter((r) => {
    const k = left.get(r.title) ?? 0;
    if (k > 0) left.set(r.title, k - 1);
    return k === 0;
  });
}

/** Status for the glyph, most urgent first: hidden (ended session), blocked, working, agents (own agents still run, also after
 *  the turn ended), done (hc: finished turn not yet seen, no agents running), bg, waiting or idle. `hcStatus` is the status of the joined hc terminal; without one the radar state decides. `recs` are the
 *  parseRecords of that terminal; `n` may be null for a terminal with no radar node. */
export function nodeStatus(n, hcStatus = null, recs = []) {
  if (!isObj(n)) {
    if (listOf(recs).length === 0) return "idle";
    n = {};
  }
  const extra = extraRecords(n, recs);
  if (n.state === "done") return "hidden";
  if (n.sym === "needs-you" || n.state === "ask" || listOf(n.asks).length > 0 || hcStatus === "blocked" || extra.some((r) => r.state === "blocked")) return "blocked";
  const running = radarRuns(n).length > 0 || extra.length > 0;
  if (hcStatus === "working") return "working";
  if (hcStatus === "done") return running ? "agents" : "done";
  if (hcStatus === null || hcStatus === undefined) {
    if (n.state === "blocked" || n.sym === "blocked") return "blocked";
    if (n.state === "working" || n.state === "starting" || n.sym === "working" || n.sym === "starting") return "working";
  }
  if (running) return "agents";
  if (listOf(n.tasks).length > 0) return "bg";
  if (n.sym === "waiting-external" || listOf(n.waits).length > 0) return "waiting";
  return "idle";
}

/** Status of an agent row: nodeStatus over the joined node (or none) and the records; the listed status stays when that
 *  finds nothing more than idle. */
export function agentStatus(listed, node, recs = []) {
  const s = nodeStatus(node, listed, recs);
  return s === "idle" || s === "hidden" ? listed : s;
}

function askText(node) {
  const age = node.blockedS !== null && (node.state === "blocked" || node.state === "ask") ? ` (${fmtAge(node.blockedS)})` : "";
  if (node.asks.length) {
    const a = node.asks[0];
    return `ask ${a.n}${a.topic ? `: ${a.topic}` : ""}${node.asks.length > 1 ? ` +${node.asks.length - 1}` : ""}${age}`;
  }
  const asking = (node.children ?? []).find((c) => c.state === "ask" && !c.ended);
  if (asking) return `ask: ${asking.role || asking.name}${age}`;
  return "";
}

function waitText(node) {
  if (!node.waits.length) return "";
  const w = node.waits.slice(0, 2).map((x) => `${x.note || x.kind}${x.ageS ? ` ${fmtAge(x.ageS)}` : ""}`);
  return `wait: ${w.join(" · ")}${node.waits.length > 2 ? ` +${node.waits.length - 2}` : ""}`;
}

/** "N agents: titles" from radar's working runs plus the records radar does not show; "" for none. `node` may be null. */
export function agentsText(node, recs = []) {
  const roles = [...radarRuns(node), ...extraRecords(node, recs).map((r) => r.title || "agent")];
  return roles.length ? `${roles.length} agent${roles.length === 1 ? "" : "s"}: ${roles.join(", ")}` : "";
}

const MAX_AGENT_LINES = 4;

/** One line per running async agent under a session or agent row: `[{glyph: "working"|"blocked"|"", text}]`, at most 4,
 *  then a `+N more` item (glyph ""). Only records without a live worker row (matched by title/role, with counts) get a
 *  line, `title · msg`; radar runs are drawn as worker rows already (the agent rows of `sessionTree`: sessions in
 *  `skip` and hidden ones are left out). Finished records are not parsed in. `node` may be null. */
export function agentLines(node, recs = [], skip = new Set()) {
  const left = new Map();
  const count = (n, depth) => {
    if (!isObj(n) || depth > MAX_DEPTH) return;
    for (const w of listOf(n.workers)) if (!w.ended) left.set(w.role || w.name, (left.get(w.role || w.name) ?? 0) + 1);
    for (const s of listOf(n.sessions)) if (!skip.has(s) && nodeStatus(s) !== "hidden") count(s, depth + 1);
  };
  count(node, 0);
  const all = listOf(recs).filter((r) => {
    const k = left.get(r.title) ?? 0;
    if (k > 0) left.set(r.title, k - 1);
    return k === 0;
  }).map((r) => ({ glyph: r.state === "blocked" ? "blocked" : "working", text: [r.title || "agent", r.msg].filter(Boolean).join(" · ") }));
  const out = all.slice(0, MAX_AGENT_LINES);
  if (all.length > MAX_AGENT_LINES) out.push({ glyph: "", text: `+${all.length - MAX_AGENT_LINES} more` });
  return out;
}

function bgText(node) {
  const t = listOf(node.tasks)[0];
  return t ? `bg: ${t.label || "task"}${t.ageS ? ` ${fmtAge(t.ageS)}` : ""}${node.tasks.length > 1 ? ` +${node.tasks.length - 1}` : ""}` : "";
}

/** Data of the lines under a top-most session's agent row. `hcStatus` is the status of the joined hc terminal. */
export function sessionRows(node, hcStatus = null, recs = []) {
  if (!isObj(node)) return { label: "", tier: "", cost: 0, costText: "", sessions: 0, ask: "", blocked: false, prs: [], summary: "", status: "idle" };
  const ask = askText(node);
  const status = nodeStatus(node, hcStatus, recs);
  const total = totalCost(node);
  return {
    label: node.name, tier: node.tier || node.rung || "", cost: total, costText: total > 0 ? fmtCost(total) : "",
    sessions: sessionCount(node), ask: ask || agentsText(node, recs) || bgText(node) || waitText(node), blocked: Boolean(ask),
    prs: sortPrs(node.prs), summary: prSummary(node.prs), status,
  };
}

// ---- open PRs ------------------------------------------------------------------------------------------------

function repoName(url, fallback) {
  const m = /^https:\/\/[^/]+\/(.+?)\/?$/.exec(str(url));
  return m ? m[1] : fallback;
}

// owner/name of a repository given as an https URL or already as owner/name; "" for none.
const nameOf = (v) => repoName(v, str(v));

/** The feed entry a PR is: same URL when both have one; else same number and repository when both know it; else the same
 *  number when exactly one feed entry has it. null when none (the PR is its own entry). */
export function twinOf(pr, feed, fallbackRepo = "") {
  const list = listOf(feed).filter(isObj);
  const repo = nameOf(pr.repo || fallbackRepo);
  const url = prUrl(null, { url: pr.url });
  const same = list.filter((f) => f.number === pr.number);
  return list.find((f) => {
    const fu = prUrl(null, { url: f.url });
    if (url && fu) return url === fu;
    if (f.number !== pr.number) return false;
    const fr = nameOf(f.repo);
    return repo && fr ? repo === fr : same.length === 1;
  }) ?? null;
}

/** The "Open PRs" section. A PR is listed once, at the first place of: (a) the row of a shown session (then not here at all),
 *  (b) a session that is not shown (the first one owning it), (c) the radar `openPrs` feed. `shown` holds the nodes and/or the
 *  node keys drawn in the tree. One group per repo, `[{repo, prs: [{...pr, href, title}]}]`. Empty when there is nothing. */
export function openPrGroups(openPrs, tops, shown = new Set()) {
  const groups = new Map();
  const feed = (Array.isArray(openPrs) ? openPrs : []).filter(isObj);
  // A PR counts once, as the feed entry it is, else by its URL, else by repo#number; with none of them it is its own entry.
  const claimed = new Set();
  const idOf = (s, pr) => {
    const twin = twinOf(pr, feed, s?.repoUrl);
    if (twin) return `f:${feed.indexOf(twin)}`;
    const url = prUrl(s, pr);
    if (url) return `u:${url}`;
    const repo = nameOf(pr.repo || s?.repoUrl);
    return repo ? `r:${repo}#${pr.number}` : "";
  };
  const sessions = allSessions(tops);
  const isShown = (s) => shown.has(s) || Boolean(s.key && shown.has(s.key));
  // (a) PRs on the row of a shown session
  for (const s of sessions) if (isShown(s)) for (const pr of s.prs) claimed.add(idOf(s, pr));
  const add = (repo, pr, href, id) => {
    if (id && claimed.has(id)) return;
    if (id) claimed.add(id);
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push({ ...pr, href, title: str(pr.title) });
  };
  // (b) sessions that are not shown, the first owner wins
  for (const s of sessions) {
    if (isShown(s)) continue;
    for (const own of s.prs) {
      const pr = enrichPrs([own], feed, s.repoUrl)[0];
      add(repoName(pr.repo || s.repoUrl, s.name || "other"), pr, prUrl(s, pr), idOf(s, own));
    }
  }
  // (c) the feed, under its repo
  feed.forEach((p) => {
    if (p.state === "merged" || p.state === "closed") return;
    add(repoName(p.repo, p.repo || "") || "other", p, prUrl(null, p), idOf(null, p));
  });
  return [...groups].map(([repo, prs]) => ({ repo, prs: sortPrs(prs) }));
}

/** "updated 12m ago" for the Open PRs header from the `openPrsAt` time (ms) and now (ms); "" when the time is unknown. */
export function openPrsAge(at, now) {
  return Number.isFinite(at) && Number.isFinite(now) ? `updated ${fmtAge(Math.max(0, now - at) / 1000)} ago` : "";
}

/** Nodes displayed under joined agents: each joined node, its workers and its nested sessions. */
export function shownNodes(joined) {
  const out = new Set();
  const add = (n, d) => {
    if (!n || d > MAX_DEPTH || out.has(n)) return;
    out.add(n);
    for (const c of n.children ?? []) add(c, d + 1);
  };
  for (const n of joined.values()) add(n, 0);
  return out;
}

/** Keys of the radar nodes drawn in the given tree items (from `sessionTree` / `hcChildItems`) and below them. */
export function shownKeys(items) {
  const out = new Set();
  const walk = (it, d) => {
    if (!isObj(it) || d > MAX_DEPTH) return;
    if (isObj(it.node) && it.node.key) out.add(it.node.key);
    for (const c of listOf(it.children)) walk(c, d + 1);
  };
  for (const it of listOf(items)) walk(it, 0);
  return out;
}

// ---- session tree (items 21, 22) -----------------------------------------------------------------------------

/** Glyph priority, most urgent first. */
export const STATUS_RANK = ["hidden", "blocked", "working", "agents", "done", "bg", "waiting", "idle"];
const rankOf = (s) => {
  const i = STATUS_RANK.indexOf(s);
  return i < 0 ? STATUS_RANK.length : i;
};

/** The most urgent of the statuses; "idle" for none. */
export function urgentStatus(list) {
  return listOf(list).reduce((best, s) => (rankOf(s) < rankOf(best) ? s : best), "idle");
}

/** The line under a top-most session's name: the open ask, else the background task, else the waits. */
export function detailLine(node) {
  if (!isObj(node)) return { text: "", blocked: false };
  const ask = askText(node);
  return { text: ask || bgText(node) || waitText(node), blocked: Boolean(ask) };
}

/** Tree of one session: its own agents and its child sessions are siblings, each child session carrying its own agents and
 *  children. Item `{id, type: "session"|"agent"|"more", label, status, urgent, children, ...}`; `urgent` is the most urgent
 *  status of the item and everything below it. Siblings are sorted by `urgent`. Sessions in `skip` and ended ones are left out.
 *  null for a non-node. */
export function sessionTree(node, { hcStatus = null, recs = [], skip = new Set(), extra = [], top = true, id: rootId = "" } = {}) {
  if (!isObj(node)) return null;
  const build = (n, status, id, depth, root) => {
    const kids = [];
    listOf(n.workers).forEach((w, i) => {
      if (w.ended) return;
      const st = nodeStatus(w);
      kids.push({ id: `${id}/a${i}`, type: "agent", label: [w.role || w.name, shortModel(w.model)].filter(Boolean).join(" "), status: st, urgent: st, children: [] });
    });
    if (root) {
      kids.push(...recItems(n, recs, skip, id));
      kids.push(...listOf(extra));
    }
    if (depth < MAX_DEPTH) {
      listOf(n.sessions).forEach((s, i) => {
        const st = nodeStatus(s);
        if (!skip.has(s) && st !== "hidden") kids.push(build(s, st, `${id}/s${i}`, depth + 1, false));
      });
    }
    const children = sortItems(kids);
    const isTop = root && top;
    const total = isTop ? totalCost(n) : num(n.cost);
    const prs = sortPrs(n.prs);
    return {
      id, type: "session", node: n, label: n.name, tier: n.tier || n.rung || "", costText: total > 0 ? fmtCost(total) : "", top: isTop,
      sessions: isTop ? sessionCount(n) : 0, status, urgent: urgentStatus([status, ...children.map((c) => c.urgent)]), children,
      prs, summary: prSummary(prs), ...splitPrs(prs),
    };
  };
  return build(node, nodeStatus(node, hcStatus, recs), rootId || node.key || node.name || "root", 0, true);
}

// Siblings by `urgent`; "+N more" items stay last.
function sortItems(kids) {
  const more = kids.filter((k) => k.type === "more");
  const rest = kids.filter((k) => k.type !== "more");
  const key = (k) => rankOf(k.urgent);
  return [...rest.map((k, i) => ({ k, i })).sort((a, b) => key(a.k) - key(b.k) || a.i - b.i).map((x) => x.k), ...more];
}

// The agent rows of hc records radar does not show (at most 4, then "+N more").
function recItems(n, recs, skip, id) {
  return agentLines(n, recs, skip).map((l, i) => {
    const st = l.glyph === "blocked" ? "blocked" : l.glyph ? "working" : "idle";
    return { id: `${id}/r${i}`, type: l.glyph ? "agent" : "more", label: l.text, status: st, urgent: st, children: [] };
  });
}

/** The pane-less hc child terminals below `address` (live ones, nested by `parent`) as tree items, to be siblings of the
 *  agent's own agents. `resolve(term)` gives `{node, recs, own, status}`: the joined radar node (or null), its hc records, the
 *  listed status of the terminal and the status to show. A joined child is a full session tree (its agents and children
 *  beneath it); one without a radar node is a bare session item with the agents of its records. Items carry `address` and
 *  `program` for the click and the logo. */
export function hcChildItems(all, address, resolve, { skip = new Set() } = {}) {
  if (!Array.isArray(all)) return [];
  const seen = new Set([address]);
  const walk = (parent, depth) => {
    if (depth > MAX_DEPTH) return [];
    const terms = all.filter((k) => isObj(k) && k.parent === parent && k.state === "live" && typeof k.address === "string" && !seen.has(k.address));
    terms.forEach((k) => seen.add(k.address));
    return terms.map((term) => {
      const r = resolve(term) ?? {};
      const below = walk(term.address, depth + 1);
      const id = `hc:${term.address}`;
      const label = (typeof term.name === "string" && term.name) || term.program?.name || term.template || term.address;
      const status = r.status ?? "idle";
      let item;
      if (isObj(r.node)) {
        item = sessionTree(r.node, { hcStatus: r.own ?? null, recs: r.recs ?? [], skip, extra: below, top: false, id });
        item.status = status;
        item.urgent = urgentStatus([status, ...item.children.map((c) => c.urgent)]);
      } else {
        const children = sortItems([...recItems(null, r.recs ?? [], skip, id), ...below]);
        item = {
          id, type: "session", node: null, label, tier: "", costText: "", top: false, sessions: 0, status,
          urgent: urgentStatus([status, ...children.map((c) => c.urgent)]), children, prs: [], summary: "", ...splitPrs([]),
        };
      }
      return { ...item, address: term.address, program: term.program ?? null };
    });
  };
  return walk(address, 0);
}

/** The children of a paned agent that has no radar node: its record agents and hc child items, as siblings. */
export function bareChildren(recs, extra) {
  return sortItems([...recItems(null, recs, new Set(), "rec"), ...listOf(extra)]);
}

/** The status an item's glyph shows: its own, or, when it is folded, the most urgent one below it. */
export function displayStatus(item, folded) {
  return isObj(item) && listOf(item.children).length > 0 && folded?.has(item.id) ? item.urgent : item?.status ?? "idle";
}

// ---- PR dot and hover card (items 17 d, 19) ------------------------------------------------------------------

/** The two-part dot of a PR: `ring` (outer, animated) while any job runs; `fill` (inner) "amber" while no job finished, "red"
 *  once a finished job failed, "green" when every finished job passed, "dim" when unknown. `conflict` is independent. */
export function prDotState(pr) {
  const checks = listOf(pr?.checks).map(jobOf).filter(Boolean).map((j) => j.state);
  const count = (s) => checks.filter((c) => c === s).length;
  const fail = count("fail");
  const ok = count("ok");
  const run = count("pending");
  return { ring: run > 0, fill: fail ? "red" : ok ? "green" : run ? "amber" : "dim", conflict: pr?.mergeable === "CONFLICTING" };
}

const CARD_CAP = 5;
const EXCERPT_MAX = 200;

/** Copy of `prs` with the title, description, mergeable flag, base and per-job names of the feed entry (same URL, else same
 *  repository and number) filled in where the PR has none. */
export function enrichPrs(prs, feed, fallbackRepo = "") {
  const open = listOf(feed);
  return listOf(prs).map((pr) => {
    const twin = twinOf(pr, open, fallbackRepo);
    if (!twin) return pr;
    const named = listOf(pr.jobs).some((j) => isObj(j) && j.name);
    return {
      ...pr, url: pr.url || twin.url, title: pr.title || twin.title, bodyText: pr.bodyText || twin.bodyText, mergeable: pr.mergeable || twin.mergeable,
      baseRef: pr.baseRef || twin.baseRef, branch: pr.branch || twin.branch,
      ...(!named && listOf(twin.jobs).length ? { jobs: twin.jobs, checks: twin.checks } : {}),
    };
  });
}

/** Data of the hover card: title, description excerpt, conflict line, counts, and the jobs grouped failed / running / passed,
 *  at most CARD_CAP names per group then `more`. */
export function prCard(pr) {
  const jobs = (listOf(pr?.jobs).length ? pr.jobs : listOf(pr?.checks)).map(jobOf).filter(Boolean);
  const named = jobs.map((j, i) => ({ name: j.name || `job ${i + 1}`, state: j.state }));
  const group = (key, label, state) => {
    const names = named.filter((j) => j.state === state).map((j) => j.name);
    return { key, label, count: names.length, names: names.slice(0, CARD_CAP), more: Math.max(0, names.length - CARD_CAP) };
  };
  const groups = [group("failed", "failed", "fail"), group("running", "running", "pending"), group("passed", "passed", "ok")];
  const text = str(pr?.bodyText).replace(/\s+/g, " ").trim();
  return {
    title: str(pr?.title) || `PR #${pr?.number ?? "?"}`,
    excerpt: text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : text,
    conflict: pr?.mergeable === "CONFLICTING" ? `conflicts with ${str(pr.baseRef) || "its base branch"}` : "",
    counts: { failed: groups[0].count, running: groups[1].count, passed: groups[2].count },
    groups: groups.filter((g) => g.count > 0),
  };
}
