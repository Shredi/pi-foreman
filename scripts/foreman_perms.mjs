#!/usr/bin/env node
// foreman perms: read-only helpers around the R41 permission gate decision log.
//   export-eval [--log <file>] [--from <file>] [--out <file>]   eval cases (JSONL) from the decision log and/or a prepared JSONL file
// `candidates` and `adopt` are phase C: they print "not in this release" and exit 2. Standard library only.
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

const usage = () => console.error("usage: foreman_perms.mjs export-eval [--log <file>] [--from <file>] [--out <file>]\n       (candidates and adopt are not in this release)");

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!["--log", "--from", "--out"].includes(a) || i + 1 >= argv.length) return null;
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

export function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "candidates" || sub === "adopt") {
    console.error("not in this release");
    return 2;
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
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const logFile = o.log ?? (o.from ? null : path.join(agentDir, "pi-foreman", "state", "gate", "log.jsonl"));
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
