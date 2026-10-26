#!/usr/bin/env node
// foreman perms: read-only helpers around the R41 permission gate decision log.
//   export-eval [--log <file>] [--from <file>] [--out <file>]   eval cases (JSONL) from the decision log and/or a prepared JSONL file
//   candidates [--log <file>] [--min N]                       shapes the review allowed >= N times (default 5) with no deny and no owner override, and shapes the owner approved in dialogs >= 2 times
// Both are read-only. Adoption has no CLI form: it is `/foreman perms adopt <shape-id>` in the owner pane. Standard library only.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SHELL_TOOLS = new Set(["bash", "foreman_bg", "bg_run", "powershell"]);
const PUBLIC_HOSTS = new Set(["github.com", "api.github.com", "gitlab.com", "npmjs.org", "registry.npmjs.org", "npmjs.com", "pypi.org", "example.com", "example.org", "example.net", "localhost"]);
const FILE_EXT = new Set(["ts", "tsx", "js", "mjs", "cjs", "json", "jsonc", "jsonl", "md", "txt", "log", "patch", "diff", "py", "sh", "ps1", "bat", "cmd", "yml", "yaml", "lock", "toml", "cfg", "env", "html", "css", "png", "svg", "rb", "go", "rs", "java", "c", "h", "map", "tgz", "zip", "tmp", "out", "bak", "conf", "ini", "pem", "key", "sock", "pid", "git"]);
const CONFIG_SECTIONS = new Set(["core", "user", "remote", "branch", "http", "credential", "alias", "url", "init", "pull", "push", "merge", "commit", "gpg", "safe"]);
const GENERIC_USERS = new Set(["x", "user", "name", "me", "public", "default", "you", "someone", "owner"]);

/** The private-string findings of one line of text: a list of category names (empty when clean). Generic patterns only. */
export function findPrivate(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)([^\s/\\'"`<>$*]+)/gi)) if (!GENERIC_USERS.has(m[1].toLowerCase())) out.add("home-path");
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(text)) out.add("email");
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) out.add("ip");
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abp]-[A-Za-z0-9-]{10,}|\b[A-Za-z0-9_-]{40,}\b/.test(text)) out.add("token");
  for (const m of text.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi)) {
    const host = m[0].toLowerCase();
    const tld = host.split(".").pop();
    if (PUBLIC_HOSTS.has(host) || CONFIG_SECTIONS.has(host.split(".")[0]) || FILE_EXT.has(tld) || !/^[a-z]{2,6}$/.test(tld)) continue;
    out.add("host");
  }
  return [...out];
}

const usage = () => console.error("usage: foreman_perms.mjs export-eval [--log <file>] [--from <file>] [--out <file>]\n       foreman_perms.mjs candidates [--log <file>] [--min N]");

function parseArgs(argv, allowed = ["--log", "--from", "--out"]) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!allowed.includes(a) || i + 1 >= argv.length) return null;
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const verdictOf = (v) => (["allow", "deny", "ask"].includes(v) ? v : null);

/** A log record as an eval case, or null when it has no usable verdict or shape. */
function fromLog(rec) {
  const expect = verdictOf(rec.verdict);
  const shape = typeof rec.shape === "string" ? rec.shape : "";
  if (!expect || !shape || typeof rec.tool !== "string") return null;
  const input = SHELL_TOOLS.has(rec.tool) ? { command: shape } : { path: shape };
  return { kind: rec.kind ?? "owner", role: rec.role ?? "foreman", tool: rec.tool, input, expect, source: "log", ...(rec.rule ? { rule: rec.rule } : {}) };
}

/** Eval cases from log records and prepared records, deduplicated by shape, private strings dropped; `stats` holds the counts. */
export function buildEval(logRecs, fromRecs) {
  const stats = { read: logRecs.length + fromRecs.length, unusable: 0, duplicates: 0, dropped: {}, written: 0 };
  const seen = new Set();
  const cases = [];
  const all = [...logRecs.map((r) => ({ c: fromLog(r), from: "log" })), ...fromRecs.map((r) => ({ c: r && verdictOf(r.expect) && typeof r.tool === "string" && r.input && typeof r.input === "object" ? { kind: "owner", role: "foreman", source: "import", ...r } : null, from: "import" }))];
  for (const { c } of all) {
    if (!c) { stats.unusable++; continue; }
    const found = findPrivate(JSON.stringify(c));
    if (found.length) { for (const f of found) stats.dropped[f] = (stats.dropped[f] ?? 0) + 1; continue; }
    const key = JSON.stringify([c.tool, c.kind, c.role, c.input, c.platform ?? ""]);
    if (seen.has(key)) { stats.duplicates++; continue; }
    seen.add(key);
    cases.push({ id: c.id ?? `${c.source}-${String(cases.length + 1).padStart(4, "0")}`, ...c });
  }
  stats.written = cases.length;
  return { cases, stats };
}

const BRANCH_SUBS = new Set(["switch", "checkout", "branch", "merge", "rebase", "push", "pull", "fetch", "cherry-pick", "reset"]);
/** Subcommands whose first operand is a remote, not a branch. */
const REMOTE_FIRST = new Set(["push", "pull", "fetch"]);

/**
 * The grouping shape of a logged command shape: the logged shape (paths already a class token) with numbers `<n>`, hex ids of 7+ characters
 * with a digit `<h>`, and the branch operands of git switch/checkout/branch/merge/rebase/push/pull/fetch `<branch>` (not the remote, not options).
 */
export function candidateShape(shape) {
  return shape
    .split(/([;|&\n]+)/)
    .map((seg) => {
      const toks = seg.split(/(\s+)/);
      const words = toks.filter((t, i) => i % 2 === 0 && t);
      if (words[0] === "git") {
        const si = words.findIndex((w, i) => i > 0 && !w.startsWith("-"));
        if (si > 0 && BRANCH_SUBS.has(words[si])) {
          let seen = 0;
          for (let i = si + 1; i < words.length; i++) {
            if (words[i].startsWith("-") || words[i].startsWith("<")) continue;
            if (REMOTE_FIRST.has(words[si]) && seen++ === 0) continue;
            words[i] = "<branch>";
          }
          let k = 0;
          for (let i = 0; i < toks.length; i += 2) if (toks[i]) toks[i] = words[k++];
        }
      }
      return toks.join("");
    })
    .join("")
    .replace(/(?<![A-Za-z<])\b[0-9a-f]{7,40}\b(?!>)/g, (m) => (/\d/.test(m) ? "<h>" : m))
    .replace(/(?<![A-Za-z<-])\d+(?![A-Za-z>])/g, "<n>");
}

/** The stable short id of a shape: first 8 hex of sha256 over tool and grouping shape. */
export const shapeId = (tool, gshape) => crypto.createHash("sha256").update(`${tool}\0${gshape}`).digest("hex").slice(0, 8);

/**
 * Candidates for the user policy's allow section from decision-log records. A shape is listed when the review allowed it `min` times (layers
 * review and cache) or the owner approved it in dialogs at least twice, and it never hit a floor, was never denied by any layer and was never refused
 * by the owner in a dialog (an override). Rows are sorted by count, then last seen.
 */
export function findCandidates(recs, min = 5) {
  const groups = new Map();
  for (const r of recs) {
    if (typeof r?.tool !== "string" || typeof r.shape !== "string" || !r.shape) continue;
    const g = candidateShape(r.shape);
    const id = shapeId(r.tool, g);
    const e = groups.get(id) ?? { id, tool: r.tool, shape: g, example: r.shape, reviewAllows: 0, dialogAllows: 0, blocked: false, last: "" };
    groups.set(id, e);
    if (r.layer === "floor" || r.verdict === "deny" || (r.layer === "dialog" && r.verdict !== "allow")) e.blocked = true;
    else if (r.verdict === "allow" && (r.layer === "review" || r.layer === "cache")) e.reviewAllows++;
    else if (r.verdict === "allow" && r.layer === "dialog" && /^allow (once|for session)$/.test(String(r.reason ?? ""))) e.dialogAllows++;
    if (typeof r.ts === "string" && r.ts > e.last) { e.last = r.ts; e.example = r.shape; }
  }
  return [...groups.values()]
    .filter((e) => !e.blocked && (e.reviewAllows >= min || e.dialogAllows >= 2))
    .map((e) => ({ id: e.id, tool: e.tool, shape: e.shape, count: e.reviewAllows + e.dialogAllows, source: e.reviewAllows >= min ? "review" : "dialog", last: e.last, example: e.example, section: "allow" }))
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
}

/** Log records of the default log file (and its rotated sibling) or of the given file. */
export function readLog(file) {
  const files = file ? [file] : [gateLogPath().replace(/log\.jsonl$/, "log.1.jsonl"), gateLogPath()];
  return files.flatMap((f) => (fs.existsSync(f) ? readJsonl(f) : []));
}

function gateLogPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "pi-foreman", "state", "gate", "log.jsonl");
}

export function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "candidates") {
    const o = parseArgs(rest, ["--log", "--min"]);
    const min = o && o.min !== undefined ? Number(o.min) : 5;
    if (!o || !Number.isInteger(min) || min < 1) {
      usage();
      return 2;
    }
    const rows = findCandidates(readLog(o.log), min);
    console.log(["id", "count", "last seen", "section", "tool", "example"].join("\t"));
    for (const r of rows) console.log([r.id, r.count, r.last, r.section, r.tool, r.example].join("\t"));
    console.error(`candidates: ${rows.length} (min ${min}). Adopt one in the owner pane with /foreman perms adopt <id>.`);
    return 0;
  }
  if (sub !== "export-eval") {
    usage();
    return 2;
  }
  const o = parseArgs(rest);
  if (!o) {
    usage();
    return 2;
  }
  const logFile = o.log ?? (o.from ? null : gateLogPath());
  const logRecs = logFile && fs.existsSync(logFile) ? readJsonl(logFile) : [];
  const fromRecs = o.from ? readJsonl(o.from) : [];
  const { cases, stats } = buildEval(logRecs, fromRecs);
  const text = cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : "");
  if (o.out) fs.writeFileSync(o.out, text);
  else process.stdout.write(text);
  const dropped = Object.entries(stats.dropped).map(([k, n]) => `${k}=${n}`).join(" ") || "none";
  console.error(`export-eval: read=${stats.read} written=${stats.written} unusable=${stats.unusable} duplicates=${stats.duplicates} dropped-private=${dropped}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
