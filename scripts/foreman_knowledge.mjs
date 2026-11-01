#!/usr/bin/env node
// `foreman knowledge check|accept|nudge` (docs/sessions.md, "Knowledge sources"). Plain Node >= 22 ESM, standard library only.
//   check [--json] [--agent-dir <dir>]   fetch every source of config/knowledge.json, normalise, hash and compare with the manifest;
//                                        reports changed, new, unreachable and newly discovered pages; caches the normalised text under
//                                        <agent dir>/pi-foreman/knowledge/<id>.md and records <agent dir>/pi-foreman/state/knowledge-check.json
//   accept <id>... | --all [--agent-dir <dir>]   write the hash and today's date of the last check into the manifest
//   nudge [--agent-dir <dir>] [--days N]   one line when the last check is older than knowledge.nudgeDays (default 30) or never ran
// Exit 0 always, 2 when the manifest is unreadable or invalid (or the arguments are). PI_FOREMAN_KNOWLEDGE_FIXTURE_DIR reads <dir>/<id> instead of the network.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(here, "..", "config", "knowledge.json");
const DEFAULTS = path.join(here, "..", "config", "foreman.defaults.json");
const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 10_000;
const DROP = new Set(["script", "style", "noscript", "svg", "template", "nav", "header", "footer", "aside"]);
const BLOCK = new Set(["p", "div", "section", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "td", "th", "table", "pre", "blockquote", "dl", "dt", "dd", "figure", "figcaption", "hr", "form", "details", "summary"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
const KEY_ORDER = ["id", "url", "target", "sha256", "checkedOn", "discover"];

/** HTML by the response content-type when there is one, else by a leading doctype or html element. */
const looksHtml = (raw, contentType) => (contentType ? /html/i.test(contentType) : /^<(?:!doctype\s+html|html)[\s>]/i.test(raw.trim()));

function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const safeChar = (code, fallback) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback);

function keepMain(html) {
  const lower = html.toLowerCase();
  for (const tag of ["main", "article"]) {
    const open = html.search(new RegExp(`<${tag}\\b`, "i"));
    const close = lower.lastIndexOf(`</${tag}>`);
    if (open >= 0 && close > open && html.indexOf(">", open) >= 0) return html.slice(open, close);
  }
  return html;
}

/** One linear pass over the tags. `strip` false: drop comments and DROP elements, keep other tags verbatim. `strip` true: remove every tag, a newline for block tags, whitespace collapsed. */
function walk(html, strip) {
  const lower = html.toLowerCase();
  const noClose = new Set();
  const out = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out.push(strip ? html.slice(i).replace(/\s+/g, " ") : html.slice(i)); break; }
    out.push(strip ? html.slice(i, lt).replace(/\s+/g, " ") : html.slice(i, lt));
    if (!strip && html.startsWith("<!--", lt) && !noClose.has("--")) {
      const end = html.indexOf("-->", lt + 4);
      if (end >= 0) { i = end + 3; continue; }
      noClose.add("--");
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) { out.push(html.slice(lt)); break; }
    const m = /^<(\/?)([a-z][a-z0-9]*)/i.exec(html.slice(lt, Math.min(gt + 1, lt + 40)));
    const name = m ? m[2].toLowerCase() : "";
    if (!strip && m && !m[1] && DROP.has(name) && !noClose.has(name)) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeGt = close < 0 ? -1 : html.indexOf(">", close);
      if (closeGt >= 0) { i = closeGt + 1; continue; }
      noClose.add(name);
    }
    if (strip) { if (BLOCK.has(name)) out.push("\n"); } else out.push(html.slice(lt, gt + 1));
    i = gt + 1;
  }
  return out.join("");
}

/** The comparable text of a fetched page: HTML is reduced to its main text (one line per block), Markdown is returned unchanged. */
export function normalise(raw, contentType) {
  if (!looksHtml(raw, contentType)) return raw;
  const html = walk(keepMain(walk(raw, false)), true);
  const lines = decode(html).split("\n").map((l) => l.replace(/[ \t\r\u00a0]+/g, " ").trim()).filter(Boolean);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export const hashText = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** `new` (the manifest has no hash yet), `changed` or `unchanged`, with the hash of the normalised text. */
export function compareSource(entry, text) {
  const sha256 = hashText(text);
  const state = !entry.sha256 ? "new" : entry.sha256 === sha256 ? "unchanged" : "changed";
  return { state, sha256 };
}

const pathKey = (u) => { try { const p = new URL(u, "https://x.invalid"); return p.pathname.replace(/\/+$/, ""); } catch { return u; } };

/** Links of an HTML page whose address matches `discover.pattern` and that are not a manifest url (compared by path); absolute, deduplicated. */
export function discoverLinks(html, baseUrl, discover, knownUrls = []) {
  const re = new RegExp(discover.pattern);
  const known = new Set(knownUrls.map(pathKey));
  const out = new Map();
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return []; }
  for (const m of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let abs;
    try { abs = new URL(decode(m[1]), baseUrl); } catch { continue; }
    if ((abs.protocol !== "http:" && abs.protocol !== "https:") || abs.origin !== origin || !re.test(abs.pathname)) continue;
    const key = abs.pathname.replace(/\/+$/, "");
    if (known.has(key) || out.has(key)) continue;
    out.set(key, { url: abs.origin + key, label: discover.label });
  }
  return [...out.values()];
}

/** The manifest with hash and date of the given results written in, in the stable key order; ids without a usable result are refused with a reason. */
export function applyAccept(manifest, ids, results, today) {
  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  const accepted = [];
  const refused = [];
  const sources = manifest.sources.map((entry) => {
    if (!ids.includes(entry.id)) return entry;
    const r = byId.get(entry.id);
    if (!r) { refused.push({ id: entry.id, reason: "no result in the last check (run foreman knowledge check)" }); return entry; }
    if (!r.sha256) { refused.push({ id: entry.id, reason: r.state === "unreachable" ? `unreachable in the last check (${r.error ?? "no detail"})` : "no hash in the last check" }); return entry; }
    accepted.push(entry.id);
    const next = { ...entry, sha256: r.sha256, checkedOn: today };
    const keys = [...KEY_ORDER.filter((k) => k in next), ...Object.keys(next).filter((k) => !KEY_ORDER.includes(k))];
    return Object.fromEntries(keys.map((k) => [k, next[k]]));
  });
  for (const id of ids) if (!manifest.sources.some((s) => s.id === id)) refused.push({ id, reason: "not in the manifest" });
  return { manifest: { ...manifest, sources }, accepted, refused };
}

const stateFile = (agentDir) => path.join(agentDir, "pi-foreman", "state", "knowledge-check.json");

/** The one-line nudge when the last check is older than `nudgeDays` (or never ran), else null. `now` is a Date or epoch milliseconds. */
export function knowledgeNudge(agentDir, nudgeDays = 30, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : now;
  let checkedAt = NaN;
  try { checkedAt = Date.parse(JSON.parse(fs.readFileSync(stateFile(agentDir), "utf8")).checkedAt); } catch { /* never ran */ }
  if (Number.isNaN(checkedAt)) return "knowledge: sources never checked (foreman knowledge check)";
  const age = t - checkedAt;
  if (age <= nudgeDays * DAY_MS) return null;
  return `knowledge: sources last checked ${Math.floor(age / DAY_MS)} days ago (foreman knowledge check)`;
}

async function fetchSource(entry) {
  const fixtureDir = process.env.PI_FOREMAN_KNOWLEDGE_FIXTURE_DIR;
  if (fixtureDir) {
    try { return { body: fs.readFileSync(path.join(fixtureDir, entry.id), "utf8") }; } catch { return { error: "fixture missing" }; }
  }
  try {
    const res = await fetch(entry.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "pi-foreman-knowledge-check" }, redirect: "follow" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { body: await res.text(), contentType: res.headers.get("content-type") ?? undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    if (!m || m.version !== 1 || !Array.isArray(m.sources) || m.sources.some((s) => !s || typeof s.id !== "string" || typeof s.url !== "string")) throw new Error("not a version 1 manifest");
    return m;
  } catch (e) {
    console.error(`foreman knowledge: cannot read ${MANIFEST}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const errText = (e) => (e instanceof Error ? e.message : String(e));

/** Fetches and compares every source; writes the cache and the state file under `agentDir`. */
export async function runCheck(manifest, agentDir, now = new Date()) {
  const knownUrls = manifest.sources.map((s) => s.url);
  const cacheDir = path.join(agentDir, "pi-foreman", "knowledge");
  let cacheError;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { cacheError = errText(e); }
  const results = await Promise.all(manifest.sources.map(async (entry) => {
    const r = { id: entry.id, url: entry.url, ...(entry.target ? { target: entry.target } : {}) };
    const got = await fetchSource(entry);
    if (got.error !== undefined) return { ...r, state: "unreachable", error: got.error };
    const text = normalise(got.body, got.contentType);
    let writeError = cacheError;
    if (entry.target && !writeError) { try { fs.writeFileSync(path.join(cacheDir, `${entry.id}.md`), text); } catch (e) { writeError = errText(e); } }
    const discovered = entry.discover ? discoverLinks(got.body, entry.url, entry.discover, knownUrls) : [];
    const cmp = entry.target || entry.sha256 ? compareSource(entry, text) : { state: "unchanged", sha256: undefined };
    return { ...r, state: cmp.state === "unchanged" && discovered.length && !entry.target ? "discovered" : cmp.state, ...(cmp.sha256 ? { sha256: cmp.sha256 } : {}), ...(discovered.length ? { discovered } : {}), ...(entry.target && writeError ? { writeError } : {}) };
  }));
  const report = { checkedAt: now.toISOString(), results };
  try {
    fs.mkdirSync(path.dirname(stateFile(agentDir)), { recursive: true });
    fs.writeFileSync(stateFile(agentDir), `${JSON.stringify(report, null, 2)}\n`);
  } catch (e) {
    report.stateError = errText(e);
  }
  return report;
}

function formatReport(report) {
  const lines = [];
  const count = { changed: 0, new: 0, unreachable: 0 };
  for (const r of report.results) {
    if (r.state in count) count[r.state]++;
    lines.push(`${r.state.padEnd(11)} ${r.id}${r.error ? `  (${r.error})` : ""}${r.state === "changed" && r.target ? `  -> reread ${r.target}` : ""}`);
    for (const d of r.discovered ?? []) lines.push(`  discovered ${d.url}  (${d.label})`);
    if (r.writeError) lines.push(`  write error: cache for ${r.id} not written (${r.writeError})`);
  }
  if (report.stateError) lines.push(`write error: state file not written (${report.stateError})`);
  const found = report.results.reduce((n, r) => n + (r.discovered?.length ?? 0), 0);
  lines.push(`knowledge: ${report.results.length} sources, ${count.changed} changed, ${count.new} new, ${count.unreachable} unreachable, ${found} newly discovered`);
  return lines.join("\n");
}

function parseArgs(argv, flags) {
  const o = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.bool.includes(a)) o[a.slice(2)] = true;
    else if (flags.value.includes(a) && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) return null;
    else o.rest.push(a);
  }
  return o;
}

const agentDirOf = (o) => o["agent-dir"] || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const usage = () => { console.error("usage: foreman knowledge check [--json] [--agent-dir <dir>]\n       foreman knowledge accept <id>... | --all [--agent-dir <dir>]\n       foreman knowledge nudge [--agent-dir <dir>] [--days N]"); return 2; };

/** `knowledge.nudgeDays` from the user config of `agentDir`, else from the defaults, else 30. */
function defaultNudgeDays(agentDir) {
  for (const file of [path.join(agentDir, "foreman.json"), DEFAULTS]) {
    try { const n = JSON.parse(fs.readFileSync(file, "utf8")).knowledge?.nudgeDays; if (Number.isFinite(n) && n >= 0) return n; } catch { /* next */ }
  }
  return 30;
}

export async function main(argv) {
  const [sub, ...args] = argv;
  if (sub === "nudge") {
    const o = parseArgs(args, { bool: [], value: ["--agent-dir", "--days"] });
    if (!o || o.rest.length) return usage();
    const days = o.days !== undefined && Number.isFinite(Number(o.days)) ? Number(o.days) : defaultNudgeDays(agentDirOf(o));
    const line = knowledgeNudge(agentDirOf(o), days);
    if (line) console.log(line);
    return 0;
  }
  if (sub === "check") {
    const o = parseArgs(args, { bool: ["--json"], value: ["--agent-dir"] });
    if (!o || o.rest.length) return usage();
    const manifest = readManifest();
    if (!manifest) return 2;
    const report = await runCheck(manifest, agentDirOf(o));
    console.log(o.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  }
  if (sub === "accept") {
    const o = parseArgs(args, { bool: ["--all"], value: ["--agent-dir"] });
    if (!o || (!o.all && !o.rest.length)) return usage();
    const manifest = readManifest();
    if (!manifest) return 2;
    let last = null;
    try { last = JSON.parse(fs.readFileSync(stateFile(agentDirOf(o)), "utf8")); } catch { /* none */ }
    const ids = o.all ? manifest.sources.filter((s) => s.target || s.sha256).map((s) => s.id) : o.rest;
    const out = applyAccept(manifest, ids, last?.results, new Date().toISOString().slice(0, 10));
    if (out.accepted.length) fs.writeFileSync(MANIFEST, `${JSON.stringify(out.manifest, null, 2)}\n`);
    for (const id of out.accepted) console.log(`accepted ${id}`);
    for (const r of out.refused) console.log(`refused ${r.id}: ${r.reason}`);
    return 0;
  }
  return usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
