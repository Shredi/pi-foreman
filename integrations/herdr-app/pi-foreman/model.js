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
      pr = { number: d.n, checks: [], url: "", repo: "" };
      byN.set(d.n, pr);
    }
    pr.checks.push(CHECK[d.state]);
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
    blockedS: int(raw.blocked_s), ageS: num(raw.age_s), ended: raw.ended_s !== null && raw.ended_s !== undefined,
    cost: own, waits, tasks, asks, prs: normDots(raw.dots, repoUrl), repoUrl, children,
  };
}

function normOpenPrs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw.slice(0, 200)) {
    if (!isObj(p) || int(p.number) === null) continue;
    const checks = Array.isArray(p.checks) ? p.checks.filter(isObj).map((c) => CHECK[c.state]).filter(Boolean) : [];
    out.push({ number: p.number, checks, url: isSafeHttpsUrl(p.url) ? p.url : "", repo: str(p.repo), title: str(p.title), state: str(p.state) });
  }
  return out;
}

/** `{nodes, openPrs}` from the text of `foreman radar --json`, or null when the text is not a radar document. */
export function parseRadarDoc(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!isObj(doc) || !Array.isArray(doc.roots)) return null;
  const budget = { left: MAX_NODES };
  const nodes = doc.roots.map((r) => normNode(r, 0, budget)).filter(Boolean);
  const at = typeof doc.openPrsAt === "string" ? Date.parse(doc.openPrsAt) : NaN;
  return { nodes, openPrs: normOpenPrs(doc.openPrs), ...(Number.isFinite(at) ? { openPrsAt: at } : {}) };
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

const urgency = (pr) => (pr.checks.includes("fail") ? 0 : pr.checks.includes("pending") ? 1 : 2);

/** Failing first, then pending, then green; newest (highest number) first inside each. */
export function sortPrs(prs) {
  return (Array.isArray(prs) ? prs.filter((p) => isObj(p) && Array.isArray(p.checks)) : [])
    .slice().sort((a, b) => urgency(a) - urgency(b) || num(b.number) - num(a.number));
}

/** "N PRs · k failing · m pending", or "N PRs · all green"; "" for none. */
export function prSummary(prs) {
  const list = Array.isArray(prs) ? prs.filter((p) => isObj(p) && Array.isArray(p.checks)) : [];
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

/** Status for the glyph: hidden (ended session), blocked, working, done (hc: finished turn not yet seen), agents, bg, waiting
 *  or idle. `hcStatus` is the status of the joined hc terminal; without one the radar state decides. `recs` are the
 *  parseRecords of that terminal; `n` may be null for a terminal with no radar node. */
export function nodeStatus(n, hcStatus = null, recs = []) {
  if (!isObj(n)) {
    if (listOf(recs).length === 0) return "idle";
    n = {};
  }
  const extra = extraRecords(n, recs);
  if (n.state === "done") return "hidden";
  if (n.sym === "needs-you" || n.state === "ask" || listOf(n.asks).length > 0 || hcStatus === "blocked" || extra.some((r) => r.state === "blocked")) return "blocked";
  if (hcStatus === "working") return "working";
  if (hcStatus === "done") return "done";
  if (hcStatus === null || hcStatus === undefined) {
    if (n.state === "blocked" || n.sym === "blocked") return "blocked";
    if (n.state === "working" || n.state === "starting" || n.sym === "working" || n.sym === "starting") return "working";
  }
  if (radarRuns(n).length > 0 || extra.length > 0) return "agents";
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
 *  line, `title · msg`; radar runs are drawn as worker rows already. Finished records are not parsed in. `node` may be null. */
export function agentLines(node, recs = []) {
  const left = new Map();
  const count = (n, depth) => {
    if (!isObj(n) || depth > MAX_DEPTH) return;
    for (const w of listOf(n.workers)) if (!w.ended) left.set(w.role || w.name, (left.get(w.role || w.name) ?? 0) + 1);
    for (const s of listOf(n.sessions)) count(s, depth + 1);
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

/** Workers and nested sessions under `node`, depth first, as flat items with tree guides (`├` `└` and `│` per level).
 *  Sessions in `skip` (they have an agent row of their own) and finished workers are left out. */
export function treeItems(node, skip = new Set(), lead = [], depth = 0) {
  if (!isObj(node) || depth > MAX_DEPTH) return [];
  const kids = [
    ...(node.workers ?? []).filter((w) => !w.ended).map((n) => ({ n, worker: true })),
    ...(node.sessions ?? []).filter((s) => !skip.has(s) && nodeStatus(s) !== "hidden").map((n) => ({ n, worker: false })),
  ];
  return kids.flatMap((k, i) => {
    const last = i === kids.length - 1;
    const lines = [...lead, last ? "└" : "├"];
    const item = k.worker
      ? { worker: true, node: k.n, lines, label: [k.n.role || k.n.name, shortModel(k.n.model)].filter(Boolean).join(" "), running: k.n.state === "working", status: nodeStatus(k.n) }
      : { worker: false, node: k.n, lines, label: k.n.name, costText: k.n.cost > 0 ? fmtCost(k.n.cost) : "", status: nodeStatus(k.n), agents: agentLines(k.n), ...splitPrs(k.n.prs) };
    return [item, ...(k.worker ? [] : treeItems(k.n, skip, [...lead, last ? "" : "│"], depth + 1))];
  });
}

// ---- open PRs ------------------------------------------------------------------------------------------------

function repoName(url, fallback) {
  const m = /^https:\/\/[^/]+\/(.+?)\/?$/.exec(str(url));
  return m ? m[1] : fallback;
}

/** The "Open PRs" section: PRs of the radar `openPrs` field plus those of session nodes that no agent row shows.
 *  `shown` is the set of nodes displayed under an agent. One group per repo, `[{repo, prs: [{...pr, href, title}]}]`;
 *  a PR is listed once (radar `openPrs` wins). Empty when there is nothing. */
export function openPrGroups(openPrs, tops, shown = new Set()) {
  const groups = new Map();
  const seen = new Set();
  // PRs under a live agent row: a radar PR is a duplicate when both have a URL and the URLs match, else when repo and number match.
  const under = allSessions(tops).filter((s) => shown.has(s)).flatMap((s) => s.prs.map((pr) => ({
    url: prUrl(s, pr), id: `${repoName(pr.repo || s.repoUrl, s.name || "other")}#${pr.number}`,
  })));
  const underAgent = (p) => under.some((u) => (u.url && p.url ? u.url === p.url : u.id === `${repoName(p.repo, p.repo || "")}#${p.number}`));
  const add = (repo, pr, href) => {
    const id = `${repo}#${pr.number}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push({ ...pr, href, title: str(pr.title) });
  };
  for (const p of Array.isArray(openPrs) ? openPrs : []) {
    if (!isObj(p) || p.state === "merged" || p.state === "closed" || underAgent(p)) continue;
    add(repoName(p.repo, p.repo || "") || "other", p, prUrl(null, p));
  }
  for (const s of allSessions(tops)) {
    if (shown.has(s)) continue;
    for (const pr of s.prs) add(repoName(pr.repo || s.repoUrl, s.name || "other"), pr, prUrl(s, pr));
  }
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
