#!/usr/bin/env node
// pi-foreman installer (design section 11). Plain Node >= 22 ESM, no dependencies.
//   node setup.mjs [--dry-run] [--project] [--overlay npm:<pkg>@<ver>] [--no-intercom] [--develop] [--remove] [--agent-dir <dir>]
//                  [--profile <name>] [--enable <id>[,<id>]] [--disable <id>[,<id>]] [--addon <id>] [--pick]
// pi-foreman itself is installed with `pi install git:github.com/Shredi/pi-foreman` (it bundles pi-subagents,
// the permission system and pi-intercom as dependencies); this script writes the config around it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  assignment, equivalentCommand, installedAddons, loadAddons, loadFeatures, loadProfiles, planChanges, resolveSetupPython, toggleable,
} from "./extensions/core-adapter/profiles.mjs";

// The shared point rule. Loaded softly: a copy of this script without the extension folder still installs, minus the compaction step.
const pointModule = await import("./extensions/core-adapter/compaction-point.mjs").catch(() => null);
const dataModule = await import("./extensions/core-adapter/pi-model-data.mjs").catch(() => null);
const PI_DEFAULT_RESERVE = pointModule?.PI_DEFAULT_RESERVE ?? 16384;
const PI_DEFAULT_KEEP_RECENT = pointModule?.PI_DEFAULT_KEEP_RECENT ?? 20000;

const ROOT = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === "win32";
const MANAGED_KEYS = ["agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"]; // same keys as /foreman doctor
const OVERLAY_RE = /^npm:(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const FOREMAN_INSTALL = "pi install git:github.com/Shredi/pi-foreman";
const FOREMAN_SOURCE = "git:github.com/Shredi/pi-foreman";
const USAGE = [
  "Usage: node setup.mjs [--dry-run] [--project] [--overlay npm:<pkg>@<ver>] [--no-intercom] [--develop] [--remove] [--agent-dir <dir>]",
  "                       [--profile <name>] [--enable <id>[,<id>]] [--disable <id>[,<id>]] [--addon <id>] [--pick]",
  `  Install pi-foreman first: ${FOREMAN_INSTALL}  (this script is also reachable as \`foreman setup\`).`,
  "  --no-intercom  filter pi-intercom out of the pi-foreman package entry and do not write its config",
  "                 (adds the filter only; delete the \"!node_modules/pi-intercom/**\" lines from settings.json to undo)",
  "  --develop      run from a checkout: write <checkout>/.pi/settings.json so the checkout replaces the installed",
  "                 package in that directory (project packages load only after Pi's trust prompt, or `pi -a`)",
  "  --remove       drop the managed settings keys and config; then run `pi remove <pi-foreman source>` yourself",
  "  --profile      apply a feature profile (orchestration, standard, full) to the user foreman.json and record it",
  "  --enable/--disable  switch toggleable features on or off after the profile (comma lists, repeatable; `foreman features list` shows the ids)",
  "  --addon        install an optional Pi add-on from config/addons.json (repeatable; installed only on this consent)",
  "  --pick         open the terminal picker again (needs a terminal; PI_FOREMAN_PICKER=off disables it, =force is a test aid)",
  "  --dry-run      show what would change, write nothing",
].join("\n");
const NO_INTERCOM_GLOB = "!node_modules/pi-intercom/**";
const BUNDLED_RE = /^npm:(pi-subagents|@gotgenes\/pi-permission-system|pi-intercom)(@.*)?$/;
const REMOTE_FOREMAN_RE = /^(npm:pi-foreman(@[^/]+)?|(github\.com\/[^/\s]+\/pi-foreman(\.git)?(@[^/]+)?\/?)|git:[^/\s]+\/([^/\s]+\/)*pi-foreman(\.git)?(@[^/]+)?\/?|https?:\/\/[^/\s]+\/([^/\s]+\/)*pi-foreman(\.git)?(@[^/]+)?\/?|git:https?:\/\/[^/\s]+\/([^/\s]+\/)*pi-foreman(\.git)?(@[^/]+)?\/?)$/;
const NO_PROFILE_HINT = "features: no profile chosen yet; run foreman setup --pick in a terminal, or pass --profile <name> [--enable/--disable <id>]";
const BRIDGE_HINT = "pi-claude-bridge: log in once. Run `CLAUDE_CONFIG_DIR=<agent dir>/pi-foreman/claude-config claude` and enter /login, or run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN (docs/install.md, \"Claude bridge: log in once\").";
const INTERCOM = "pi-intercom";
// pi-subagents runs this after creating a managed worktree (config: <agent dir>/extensions/subagent/config.json). POSIX only:
// pi-subagents spawns the hook without a shell, so a script cannot run on Windows (docs/safety.md, known limits).
const WORKTREE_HOOK_TIMEOUT_MS = 600000;
// Written once when absent (never overwritten): wake on every inbound message, the human's input first.
const INTERCOM_CONFIG = { inboundTrigger: "always", busyDelivery: "human-first" };
// Keys that change the program pi-intercom starts or enable sends over SSH: trusted overrides, warned about.
const INTERCOM_RISKY_KEYS = ["brokerCommand", "brokerArgs", "crossMachine"];
// Providers an extension registers at runtime (no Pi registry file) that serve another provider's model ids: price tiers come from the base.
const BUILTIN_MODEL_DATA_FROM = { "claude-bridge": "anthropic" };

class Fatal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const say = (s = "") => console.log(s);

// ---------------------------------------------------------------- helpers

const csv = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

function parseArgs(argv) {
  const o = { dryRun: false, project: false, remove: false, overlay: null, agentDir: null, noIntercom: false, develop: false, profile: null, enable: [], disable: [], addon: [], pick: false };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].startsWith("--") ? argv[i].indexOf("=") : -1;
    const flag = eq >= 0 ? argv[i].slice(0, eq) : argv[i];
    const inline = eq >= 0 ? argv[i].slice(eq + 1) : null;
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v) throw new Fatal(`${flag} needs a value.\n${USAGE}`, 2);
      return v;
    };
    if (flag === "--dry-run") o.dryRun = true;
    else if (flag === "--project") o.project = true;
    else if (flag === "--remove") o.remove = true;
    else if (flag === "--no-intercom") o.noIntercom = true;
    else if (flag === "--develop") o.develop = true;
    else if (flag === "--overlay") o.overlay = value();
    else if (flag === "--agent-dir") o.agentDir = value();
    else if (flag === "--profile") o.profile = value();
    else if (flag === "--enable") o.enable.push(...csv(value()));
    else if (flag === "--disable") o.disable.push(...csv(value()));
    else if (flag === "--addon") o.addon.push(...csv(value()));
    else if (flag === "--pick") o.pick = true;
    else if (flag === "--help" || flag === "-h") throw new Fatal(USAGE, 0);
    else throw new Fatal(`Unknown argument: ${argv[i]}\n${USAGE}`, 2);
  }
  if (o.overlay !== null && !OVERLAY_RE.test(o.overlay)) {
    throw new Fatal(`--overlay needs an exact version, e.g. npm:@scope/pkg@1.2.3 (got "${o.overlay}"). Ranges and tags are refused.`, 2);
  }
  if (o.overlay && o.remove) throw new Fatal("--overlay and --remove cannot be combined.", 2);
  if (o.develop && (o.remove || o.project)) throw new Fatal("--develop cannot be combined with --remove or --project.", 2);
  const named = [o.profile && "--profile", o.enable.length && "--enable", o.disable.length && "--disable", o.addon.length && "--addon"].filter(Boolean);
  if (o.remove && (named.length || o.pick)) throw new Fatal(`${[...named, o.pick && "--pick"].filter(Boolean).join(", ")} cannot be combined with --remove.`, 2);
  if (o.pick && named.length) throw new Fatal(`--pick cannot be combined with ${named.join(", ")}: the picker opens only without feature or add-on flags.`, 2);
  const plan = planChanges({}, { profile: o.profile ?? undefined, enable: o.enable, disable: o.disable });
  if (plan.errors.length) throw new Fatal(plan.errors.join("\n"), 2);
  const addonIds = loadAddons().addons.map((a) => a.id);
  const badAddon = o.addon.filter((id) => !addonIds.includes(id));
  if (badAddon.length) throw new Fatal(`unknown add-on ${badAddon.join(", ")}; valid: ${addonIds.join(", ")}`, 2);
  return o;
}

function resolveAgentDir(arg) {
  let d = arg || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) d = path.join(os.homedir(), d.slice(1));
  return path.resolve(d);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function parseJsonObject(text, file) {
  if (text === null) return null;
  let v;
  try {
    v = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new Fatal(`${file} is not valid JSON (${err.message}). Fix it by hand; the installer will not overwrite it.`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Fatal(`${file} must contain a JSON object.`);
  return v;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const toJson = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** Stable stringify (sorted keys); same as canonical() in the adapter's config.ts. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sha = (v) => crypto.createHash("sha256").update(canonical(v)).digest("hex");

function pick(block) {
  const out = {};
  if (isObj(block)) for (const k of MANAGED_KEYS) if (block[k] !== undefined) out[k] = block[k];
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(".", "").replace("T", "-").replace("Z", "");
}

/** Line-level unified diff (LCS), 2 lines of context, one hunk per change cluster. */
export function unifiedDiff(label, before, after) {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  // ops: [tag, text, aLine, bLine] with 0-based line numbers of the next line on each side.
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([" ", a[i++], i, ++j]);
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(["-", a[i++], i, j]);
    else ops.push(["+", b[j++], i, j]);
  }
  const ctx = 2;
  const lines = [`--- ${before === null ? "/dev/null" : `a/${label}`}`, `+++ b/${label}`];
  const changed = ops.map((o, k) => (o[0] === " " ? -1 : k)).filter((k) => k >= 0);
  let g = 0;
  while (g < changed.length) {
    let h = g;
    while (h + 1 < changed.length && changed[h + 1] - changed[h] <= 2 * ctx + 1) h++;
    const start = Math.max(0, changed[g] - ctx);
    const end = Math.min(ops.length - 1, changed[h] + ctx);
    const slice = ops.slice(start, end + 1);
    const aCount = slice.filter((o) => o[0] !== "+").length;
    const bCount = slice.filter((o) => o[0] !== "-").length;
    const aStart = aCount ? slice.find((o) => o[0] !== "+")[2] : slice[0][2];
    const bStart = bCount ? slice.find((o) => o[0] !== "-")[3] : slice[0][3];
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) lines.push(`${o[0]}${o[1]}`);
    g = h + 1;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- Pi

/** The JS entry a Windows `pi.cmd` shim in `dir` launches, or null. */
function shimScript(cmd, dir) {
  const m = /%dp0%[\\/]+([^"\r\n]+?\.(?:c|m)?js)"/i.exec(fs.readFileSync(cmd, "utf8"));
  return m ? path.resolve(dir, m[1]) : null;
}

/**
 * How to run `pi` without a shell. PI_FOREMAN_PI_BIN is a Node script run via this Node
 * (test stubs, or pi's cli.js). On Windows `pi` is a .cmd shim and Node refuses to spawn
 * .cmd directly; we read the shim, find the JS entry it launches and run that with Node.
 * No user-controlled string ever reaches a shell line.
 */
function piCommand() {
  const bin = process.env.PI_FOREMAN_PI_BIN;
  if (bin) return { command: process.execPath, prefix: [path.resolve(bin)] };
  if (!WIN) return { command: "pi", prefix: [] };
  const dirs = (process.env.PATH || process.env.Path || "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, "pi.exe");
    if (fs.existsSync(exe)) return { command: exe, prefix: [] };
    const cmd = path.join(dir, "pi.cmd");
    if (fs.existsSync(cmd)) {
      const js = shimScript(cmd, dir);
      if (js && fs.existsSync(js)) return { command: process.execPath, prefix: [js] };
      throw new Fatal(`Found ${cmd} but could not read the script it launches. Set PI_FOREMAN_PI_BIN to pi's cli.js (inside the @earendil-works/pi-coding-agent package) and re-run.`);
    }
  }
  throw new Fatal("`pi` was not found on PATH. Install Pi first (npm install -g @earendil-works/pi-coding-agent).");
}

/** Pi's chat models of one provider: Map<id, { contextWindow, tiers }> from <dir>/<provider>.json ({"<api>":{"chat:<id>":{...}}}); other prefixes are skipped. */
function readProviderModels(dir, provider) {
  const text = readText(path.join(dir, `${provider}.json`));
  const out = new Map();
  if (text === null) return out;
  const data = JSON.parse(text);
  for (const apiBlock of isObj(data) ? Object.values(data) : []) {
    if (!isObj(apiBlock)) continue;
    for (const [key, m] of Object.entries(apiBlock)) {
      if (!key.startsWith("chat:") || !isObj(m)) continue;
      out.set(key.slice(5), { contextWindow: m.contextWindow, tiers: isObj(m.cost) && Array.isArray(m.cost.tiers) ? m.cost.tiers : [] });
    }
  }
  return out;
}

/** Pi's formatTokenCount (cli/list-models.js): the `context` column of `pi --list-models`. */
function formatTokenCount(count) {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * The context window a `context` cell stands for: the exact base window when it formats identically; else an integer K/M or a
 * bare integer exactly; else a one-decimal N.NK as its upper bound (t*100+50 by tenths, 1000.0K capped at 999999, at most 100
 * tokens above the true count). "inexact" for a one-decimal N.NM that matches no base window; null when unreadable.
 */
function windowFromListing(cell, baseWindow) {
  if (typeof baseWindow === "number" && Number.isFinite(baseWindow) && formatTokenCount(baseWindow) === cell) return baseWindow;
  let m;
  if ((m = /^(\d+)K$/.exec(cell))) return Number(m[1]) * 1000;
  if ((m = /^(\d+)M$/.exec(cell))) return Number(m[1]) * 1_000_000;
  if ((m = /^(\d+)$/.exec(cell))) return Number(m[1]);
  if ((m = /^(\d+)\.(\d)K$/.exec(cell))) return Math.min(Number(m[1] + m[2]) * 100 + 50, 999999);
  if (/^\d+\.\dM$/.test(cell)) return "inexact";
  return null;
}

/** `pi --list-models` as { rows: Map<provider, Map<id, context cell>> }, or { why } when it failed (non-zero exit, timeout, no header row). */
function readModelListing(pi, { agentDir, cwd }) {
  const r = runPi(pi, ["--list-models"], { agentDir, cwd, timeoutMs: 60_000 });
  if (r.error) return { why: r.error.code === "ETIMEDOUT" ? "timed out" : r.error.message };
  if (r.code !== 0) return { why: `exit ${r.code}` };
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/));
  const header = lines.findIndex((c) => c.length === 6 && c[0] === "provider" && c[1] === "model" && c[2] === "context");
  if (header < 0) return { why: "no model list printed" };
  const rows = new Map();
  for (const c of lines.slice(header + 1)) {
    if (c.length !== 6) continue;
    if (!rows.has(c[0])) rows.set(c[0], new Map());
    rows.get(c[0]).set(c[1], c[2]);
  }
  return { rows };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const stripLevel = (ref) => {
  const i = ref.lastIndexOf(":");
  return i > 0 && THINKING_LEVELS.has(ref.slice(i + 1)) ? ref.slice(0, i) : ref;
};
function globMatches(glob, text) {
  const body = glob.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`).test(text);
}

function setOverride(obj, key, reserve) {
  if (!isObj(obj.compaction)) obj.compaction = {};
  if (!isObj(obj.compaction.modelOverrides)) obj.compaction.modelOverrides = {};
  if (!isObj(obj.compaction.modelOverrides[key])) obj.compaction.modelOverrides[key] = {};
  obj.compaction.modelOverrides[key].reserveTokens = reserve;
}

/** Delete modelOverrides[key].reserveTokens and any container that is empty because of it. */
function dropOverride(obj, key) {
  const c = obj.compaction;
  if (!isObj(c) || !isObj(c.modelOverrides) || !isObj(c.modelOverrides[key])) return;
  delete c.modelOverrides[key].reserveTokens;
  if (Object.keys(c.modelOverrides[key]).length === 0) delete c.modelOverrides[key];
  if (Object.keys(c.modelOverrides).length === 0) delete c.modelOverrides;
  if (Object.keys(c).length === 0) delete obj.compaction;
}

const reserveOf = (obj, key) => (isObj(obj?.compaction?.modelOverrides?.[key]) ? obj.compaction.modelOverrides[key].reserveTokens : undefined);

function runPi(pi, args, { agentDir, cwd, timeoutMs = 10 * 60_000 }) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const r = spawnSync(pi.command, [...pi.prefix, ...args], { encoding: "utf8", timeout: timeoutMs, env, cwd, windowsHide: true });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

function rangeMatches(version, range) {
  const v = version.split(".");
  return range.split(".").every((p, i) => p === "x" || p === "*" || p === v[i]);
}

function checkPi(pi, lock, agentDir, cwd) {
  const r = runPi(pi, ["--version"], { agentDir, cwd, timeoutMs: 30_000 });
  if (r.error) throw new Fatal(`Could not run pi: ${r.error.message}. Install Pi (npm install -g ${lock.pi.name}@${lock.pi.version}) or fix PATH.`);
  const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 || !m) throw new Fatal(`\`pi --version\` gave no usable answer (exit ${r.code}).`);
  if (!rangeMatches(m[1], lock.pi.range)) {
    throw new Fatal(`Pi ${m[1]} is outside the supported range ${lock.pi.range}. Install ${lock.pi.name}@${lock.pi.version} (pinned) and re-run.`);
  }
  return m[1];
}

// ---------------------------------------------------------------- Python

/** The shared resolver (profiles.mjs, also used by the features CLI), failing the way setup fails. */
function resolvePython(agentDir) {
  try {
    return resolveSetupPython(agentDir);
  } catch (err) {
    throw new Fatal(err.message);
  }
}

function runConfigCli(py, args, cwd, script = "foreman_config.py") {
  const r = spawnSync(py.executable, ["-E", "-s", path.join(ROOT, "scripts", script), ...args], { encoding: "utf8", timeout: 30_000, cwd, windowsHide: true });
  if (r.error) throw new Fatal(`Could not run foreman_config.py: ${r.error.message}`);
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    /* handled by the caller */
  }
  return { code: r.status, data, stderr: (r.stderr || "").trim() };
}

// ---------------------------------------------------------------- packages

/** `./node_modules/...` entries of the package manifest (package.json `pi.*` arrays) that do not resolve under `root`. */
function missingBundledEntries(root) {
  let pi;
  try {
    pi = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).pi;
  } catch {
    return [];
  }
  const entries = isObj(pi) ? Object.values(pi).flatMap((v) => (Array.isArray(v) ? v : isObj(v) ? Object.values(v).flat() : [])) : [];
  return entries.filter((e) => typeof e === "string" && e.startsWith("./node_modules/") && !fs.existsSync(path.join(root, e)));
}

/**
 * Why `npm ci` must run in the checkout `root`: "missing" (no node_modules), "stale" (package-lock.json is newer than the
 * node_modules/.package-lock.json npm writes on every install), or null (fresh, or no package-lock.json).
 */
export function npmCiReason(root) {
  let lockTime;
  try {
    lockTime = fs.statSync(path.join(root, "package-lock.json")).mtimeMs;
  } catch {
    return null;
  }
  try {
    return fs.statSync(path.join(root, "node_modules", ".package-lock.json")).mtimeMs < lockTime ? "stale" : null;
  } catch {
    return "missing";
  }
}

function entrySource(e) {
  if (typeof e === "string") return e;
  if (isObj(e) && typeof e.source === "string") return e.source;
  return null;
}

/** Is the exact npm pin `spec` recorded in settings.packages? */
function isRecorded(settings, spec) {
  const list = settings && Array.isArray(settings.packages) ? settings.packages : [];
  return list.some((e) => entrySource(e) === spec);
}

const isLocalSource = (src) => !/^(npm|git|https?|ssh):/.test(src) && !src.startsWith("git@");
const isBridgeEntry = (e) => /(^|[/:@])pi-claude-bridge(@|$|\/)/.test(entrySource(e) ?? "");
const isBundledEntry = (e) => BUNDLED_RE.test(entrySource(e) ?? "");
const isRemoteForeman = (e) => REMOTE_FOREMAN_RE.test(entrySource(e) ?? "");
const resolveLocal = (src, baseDir) => {
  const r = path.resolve(baseDir, src);
  try {
    return fs.realpathSync(r);
  } catch {
    return r;
  }
};
/** A local-path entry whose package.json says it is pi-foreman. */
function isLocalForeman(e, baseDir) {
  const src = entrySource(e);
  if (!src || !isLocalSource(src)) return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveLocal(src, baseDir), "package.json"), "utf8")).name === "pi-foreman";
  } catch {
    return false;
  }
}
const isForemanEntry = (e, baseDir) => isRemoteForeman(e) || isLocalForeman(e, baseDir);

/** The pi-foreman entry with the pi-intercom exclusion added (object form), or the same entry when already filtered. */
function withoutIntercom(e) {
  const o = isObj(e) ? structuredClone(e) : { source: e };
  for (const k of ["extensions", "skills"]) {
    const cur = Array.isArray(o[k]) ? o[k] : [];
    o[k] = cur.includes(NO_INTERCOM_GLOB) ? cur : [...cur, NO_INTERCOM_GLOB];
  }
  return canonical(o) === canonical(e) ? e : o;
}

/**
 * `packages` with the pi-foreman entry moved right before the first pi-claude-bridge entry, or
 * null when no move is needed. Pi runs session_before_compact / session_before_tree handlers in
 * load order (= this list order) and stops at the first cancel; the bridge's own handler starts
 * Claude Code, so pi-foreman's config-drift check has to come first.
 */
function foremanBeforeBridge(list, baseDir) {
  if (!Array.isArray(list)) return null;
  const bridge = list.findIndex(isBridgeEntry);
  const foreman = list.findIndex((e) => isForemanEntry(e, baseDir));
  if (bridge < 0 || foreman < 0 || foreman < bridge) return null;
  const out = list.filter((_, i) => i !== foreman);
  out.splice(bridge, 0, list[foreman]);
  return out;
}

// ---------------------------------------------------------------- main

class Aborted extends Error {}

/** The profile line of a picker menu: title, summary and the features the profile turns off. */
function profileDescription(profiles, name) {
  const off = Object.entries(profiles[name].features ?? {}).filter(([, v]) => !v).map(([k]) => k);
  return `${profiles[name].title}. ${profiles[name].summary}${off.length ? ` Off: ${off.join(", ")}.` : ""}`;
}

const RELAX_WARNING = "WARNING: each of these loosens a safety guard; leave them off unless you know you need them.";

/** The toggle groups of the picker: one per area, then the safety relaxations last. */
function toggleGroups(features) {
  const toggles = toggleable(features);
  const areas = [...new Set(toggles.filter((f) => !f.toggle.relaxes).map((f) => f.area))];
  const groups = areas.map((area) => ({ title: area, list: toggles.filter((f) => f.area === area && !f.toggle.relaxes) }));
  groups.push({ title: "safety relaxations", list: toggles.filter((f) => f.toggle.relaxes), warn: RELAX_WARNING });
  return groups;
}

/** A feature that is on and whose "on" leaves include a null (the setting is removed and pi-foreman decides) is shown as "auto". */
const isAuto = (f, state) => state === "on" && Object.values(f.toggle.on).some((v) => v === null);

/** The add-on step shared by both pickers: what is installed, or what an add-on does and what it clashes with. */
function describeAddon(a, have) {
  if (have) return [`Add-on ${a.id}: already installed (${have.source}, ${have.scope})`];
  return [`Add-on ${a.id}: ${a.purpose}`, `  installs npm:${a.package}@${a.version}`, ...a.clashes.map((c) => `  note: ${c}`)];
}

/** The summary both pickers print before the final confirm: line-level diff, planned installs, relaxations, equivalent flag line. */
function printPickerSummary({ currentText, currentConfig, profile, enable, disable, addons, project }) {
  const plan = planChanges(currentConfig, { profile, enable, disable });
  say("Summary:");
  say(`  profile: ${profile}`);
  say(canonical(plan.config) === canonical(currentConfig) && currentText !== null ? "  foreman.json: no change" : unifiedDiff("foreman.json", currentText, toJson(plan.config)));
  for (const id of addons) {
    const a = loadAddons().addons.find((x) => x.id === id);
    say(`  would run: pi install npm:${a.package}@${a.version}${project ? " -l" : ""}`);
  }
  if (plan.relaxations.length) say(`WARN safety relaxations on: ${plan.relaxations.join(", ")}`);
  say(`  equivalent: ${equivalentCommand({ profile, enable, disable, addons, project })}`);
}

/** enable/disable relative to the profile's own assignment. */
function diffStates(base, states) {
  return {
    enable: Object.keys(states).filter((id) => states[id] === "on" && base[id] === "off"),
    disable: Object.keys(states).filter((id) => states[id] === "off" && base[id] === "on"),
  };
}

/** Which picker a run gets: the arrow-key menu on a real terminal, the readline menu for PI_FOREMAN_PICKER=force without one. */
export function pickerKind({ tty }) {
  return tty ? "inquirer" : "readline";
}

export const INQUIRER_MISSING_NOTE = "picker: @inquirer/prompts missing, run npm ci (checkout) or reinstall the package; using the basic menu";

/** The picker dispatch. `load` is the dynamic import (replaceable in tests). Same result shape either way. */
export async function runPicker(ctx, { tty = !!(process.stdin.isTTY && process.stdout.isTTY), load = () => import("@inquirer/prompts") } = {}) {
  if (pickerKind({ tty }) === "inquirer") {
    let prompts;
    try {
      prompts = await load();
    } catch {
      say(INQUIRER_MISSING_NOTE);
    }
    if (prompts) return runPickerInquirer(ctx, prompts);
  }
  return runPickerReadline(ctx);
}

/**
 * The arrow-key picker on @inquirer/prompts: select (profile), confirm (adjust), checkbox per area, confirm per add-on, summary, confirm.
 * Resolves like runPickerReadline; Ctrl-C (ExitPromptError) and a declined confirm give null.
 */
async function runPickerInquirer({ currentText, currentConfig, recorded, installed, project }, { select, checkbox, confirm }) {
  const features = loadFeatures();
  const profiles = loadProfiles().profiles;
  const names = Object.keys(profiles);
  try {
    const preset = names.includes(recorded) ? recorded : "standard";
    const profile = await select({
      message: "Profile",
      default: preset,
      choices: names.map((n) => ({ name: n, value: n, description: profileDescription(profiles, n) })),
    });
    const base = assignment(profile);
    const states = { ...base };
    if (await confirm({ message: "Adjust features?", default: false })) {
      for (const g of toggleGroups(features)) {
        if (g.warn) say(g.warn);
        const on = await checkbox({
          message: g.title,
          choices: g.list.map((f) => ({ name: `${f.id}${isAuto(f, "on") ? " (auto)" : ""} - ${f.title}`, value: f.id, checked: states[f.id] === "on" })),
        });
        for (const f of g.list) states[f.id] = on.includes(f.id) ? "on" : "off";
      }
    }
    const { enable, disable } = diffStates(base, states);
    const addons = [];
    for (const a of loadAddons().addons) {
      const have = installed.find((i) => i.id === a.id);
      for (const l of describeAddon(a, have)) say(l);
      if (!have && (await confirm({ message: `Install ${a.id}?`, default: false }))) addons.push(a.id);
    }
    printPickerSummary({ currentText, currentConfig, profile, enable, disable, addons, project });
    if (!(await confirm({ message: "Apply?", default: false }))) return null;
    return { profile, enable, disable, addons };
  } catch (err) {
    if (err && err.name === "ExitPromptError") {
      say("");
      return null;
    }
    throw err;
  }
}

/**
 * The fallback picker (plain readline, numbered ASCII menus): profile, optional per-area toggles, add-on consent, summary, confirm.
 * Resolves to { profile, enable, disable, addons } (enable/disable relative to the profile), or null on "no", EOF or Ctrl-C.
 */
async function runPickerReadline({ currentText, currentConfig, recorded, installed, project }) {
  const features = loadFeatures();
  const profiles = loadProfiles().profiles;
  const names = Object.keys(profiles);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => rl.close());
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    rl.setPrompt(question);
    rl.prompt();
    const { value, done } = await lines.next();
    if (done) throw new Aborted();
    return String(value).trim();
  };
  const yes = async (question) => /^y/i.test(await ask(question));
  try {
    say("Profiles:");
    names.forEach((n, i) => {
      say(`  ${i + 1}) ${n} - ${profileDescription(profiles, n)}`);
    });
    const preset = names.includes(recorded) ? recorded : "standard";
    let profile = null;
    while (!profile) {
      const a = await ask(`Profile [${names.indexOf(preset) + 1}]: `);
      profile = a === "" ? preset : /^\d+$/.test(a) ? names[Number(a) - 1] : names.find((n) => n === a);
      if (!profile) say(`  choose 1-${names.length} or a profile name`);
    }
    const base = assignment(profile);
    const states = { ...base };
    if (await yes("Adjust features? [y/N]: ")) {
      for (const g of toggleGroups(features)) {
        say(`${g.title}:`);
        if (g.warn) say(`  ${g.warn}`);
        for (;;) {
          g.list.forEach((f, i) => {
            say(`  ${i + 1}) [${states[f.id] === "on" ? "x" : " "}] ${f.id}${isAuto(f, states[f.id]) ? " (auto)" : ""} - ${f.title}`);
          });
          const picks = (await ask("Flip (numbers, Enter to continue): ")).split(/[\s,]+/).filter(Boolean);
          if (!picks.length) break;
          for (const p of picks) {
            const f = g.list[Number(p) - 1];
            if (f) states[f.id] = states[f.id] === "on" ? "off" : "on";
            else say(`  no entry ${p}`);
          }
        }
      }
    }
    const { enable, disable } = diffStates(base, states);
    const addons = [];
    for (const a of loadAddons().addons) {
      const have = installed.find((i) => i.id === a.id);
      for (const l of describeAddon(a, have)) say(l);
      if (!have && (await yes(`Install ${a.id}? [y/N]: `))) addons.push(a.id);
    }
    printPickerSummary({ currentText, currentConfig, profile, enable, disable, addons, project });
    if (!(await yes("Apply? [y/N]: "))) return null;
    return { profile, enable, disable, addons };
  } catch (err) {
    if (err instanceof Aborted) {
      say("");
      return null;
    }
    throw err;
  } finally {
    rl.close();
  }
}

/** What the environment allows for the picker: PI_FOREMAN_PICKER=force (test and automation aid) overrides the TTY and CI tests, =off disables it. */
function pickerState() {
  const mode = process.env.PI_FOREMAN_PICKER;
  const force = mode === "force";
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  return { off: mode === "off", force, tty, ci: !!process.env.CI, allowed: mode !== "off" && (force || (tty && !process.env.CI)) };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.pick) {
    // --pick needs every picker precondition except "no profile recorded"
    const st = pickerState();
    if (st.off) throw new Fatal("--pick cannot run: PI_FOREMAN_PICKER=off disables the picker.", 2);
    if (!st.force && !st.tty) throw new Fatal("--pick needs a terminal: stdin and stdout must both be TTYs (PI_FOREMAN_PICKER=force overrides, for tests).", 2);
    if (!st.force && st.ci) throw new Fatal("--pick cannot run while CI is set (PI_FOREMAN_PICKER=force overrides, for tests).", 2);
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Fatal(`Node ${process.versions.node} is too old; pi-foreman needs Node >= 22.`);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "packages.lock.json"), "utf8"));
  const agentDir = resolveAgentDir(opts.agentDir);
  const projectDir = process.cwd();
  const settingsFile = opts.project ? path.join(projectDir, ".pi", "settings.json") : path.join(agentDir, "settings.json");
  const baseDir = path.dirname(settingsFile);
  const managedFile = path.join(agentDir, "pi-foreman", "managed.json");
  const foremanFile = path.join(agentDir, "foreman.json");
  const permFile = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
  const dry = opts.dryRun;

  say(`pi-foreman installer${dry ? " (dry run: nothing will be written)" : ""}${opts.remove ? " [remove]" : ""}`);
  say(`  agent dir: ${agentDir}`);
  say(`  settings:  ${settingsFile}${opts.project ? " (project)" : ""}`);

  // A checkout (not a pi-managed install) whose lockfile changed since the last install: reinstall, so a merge that bumped a dependency takes effect.
  const ciReason = opts.remove || !fs.existsSync(path.join(ROOT, ".git")) ? null : npmCiReason(ROOT);
  if (ciReason) {
    say(`  package-lock.json: node_modules ${ciReason === "missing" ? "missing" : "older than the lock"}, ${dry ? "would run" : "running"} npm ci in ${ROOT}`);
    if (!dry) {
      const r = spawnSync(WIN ? "npm.cmd" : "npm", ["ci"], { cwd: ROOT, stdio: "inherit", shell: WIN, windowsHide: true });
      if (r.error || r.status !== 0) throw new Fatal(`npm ci failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}. Fix it and run \`foreman setup\` again.`);
    }
  }

  const pi = piCommand();
  const piVersion = checkPi(pi, lock, agentDir, projectDir);
  say(`  node ${process.versions.node}, pi ${piVersion} (supported ${lock.pi.range})`);

  const settingsText = readText(settingsFile);
  const settings = parseJsonObject(settingsText, settingsFile) ?? {};
  const managedText = readText(managedFile);
  const managed = parseJsonObject(managedText, managedFile) ?? { version: 1, entries: {} };
  if (!isObj(managed.entries)) managed.entries = {};
  const record = managed.entries[settingsFile] ?? null;

  let backedUp = false;
  const backup = () => {
    if (backedUp || settingsText === null) return;
    const file = `${settingsFile}.bak-${timestamp()}`;
    fs.copyFileSync(settingsFile, file);
    backedUp = true;
    say(`  backup: ${file}`);
  };
  const writeFile = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const runOrDie = (args) => {
    say(`  run: pi ${args.join(" ")}`);
    const r = runPi(pi, args, { agentDir, cwd: projectDir });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 8).map((l) => l.slice(0, 200)).join("\n");
      throw new Fatal(`pi ${args.join(" ")} failed (exit ${r.code}):\n${tail}`);
    }
  };

  // Add-ons are found in both settings files: a second copy of a package stops Pi at start.
  const packagesOf = (file) => {
    try {
      const s = parseJsonObject(readText(file), file);
      return Array.isArray(s?.packages) ? s.packages : [];
    } catch {
      return [];
    }
  };
  const addonsInstalled = () => installedAddons(packagesOf(path.join(agentDir, "settings.json")), packagesOf(path.join(projectDir, ".pi", "settings.json")));

  /**
   * Validates the candidate user config the way the current one validates today: it blocks only on error strings the baseline
   * (`baseText`: null validates the current file in place, else the template text when the file is new) lacks, so a file with an old error can still be changed. Fatal 1, nothing written.
   */
  function guardUserConfig(py, baseText, candidateText) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-setup-"));
    try {
      const errorsOf = (text) => {
        let userFile = [];
        if (text !== null) {
          const file = path.join(tmp, "foreman.json");
          fs.writeFileSync(file, text);
          userFile = ["--user-file", file];
        }
        const r = runConfigCli(py, ["validate", "--json", "--agent-dir", agentDir, "--project-dir", projectDir, ...(opts.project ? ["--trusted-project"] : []), ...userFile], projectDir);
        if (!r.data) throw new Fatal(`validate failed (exit ${r.code}): ${r.stderr || "no JSON output"}`);
        return Array.isArray(r.data.errors) ? r.data.errors : [];
      };
      const before = errorsOf(baseText);
      const added = errorsOf(candidateText).filter((e) => !before.includes(e));
      if (added.length) {
        for (const e of added) say(`  foreman.json error: ${e}`);
        throw new Fatal("The change would make foreman.json invalid; nothing was written.");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return opts.remove ? removeAll() : install();

  // ------------------------------------------------------------ remove
  function removeAll() {
    const installed = (Array.isArray(settings.packages) ? settings.packages : []).find((e) => isForemanEntry(e, baseDir));
    const removeLine = `pi remove ${(installed && entrySource(installed)) || FOREMAN_SOURCE}${opts.project ? " -l" : ""}`;
    for (const a of addonsInstalled()) say(`add-ons installed: ${a.id} (${a.source}); kept, remove with: pi remove ${a.source}${a.scope === "project" ? " -l" : ""}`);
    const cur = isObj(settings.subagents) ? pick(settings.subagents) : {};
    const dropManaged = (obj) => {
      if (!isObj(obj.subagents)) return;
      for (const k of MANAGED_KEYS) delete obj.subagents[k];
      if (Object.keys(obj.subagents).length === 0) delete obj.subagents;
    };
    let next = null;
    if (Object.keys(cur).length === 0) say("subagents block: none present");
    else if (record && sha(cur) === record.subagentsHash) {
      next = structuredClone(settings);
      dropManaged(next);
      say("subagents block: unchanged since written, removing");
    } else say("subagents block: not ours or edited by hand, kept");
    // compaction overrides: only the ones still equal to the recorded value are ours to delete
    const derived = isObj(record?.compactionDerived) ? record.compactionDerived : {};
    const ownedKeys = Object.keys(derived).filter((k) => reserveOf(settings, k) === derived[k]);
    for (const k of Object.keys(derived)) say(ownedKeys.includes(k) ? `compaction ${k}: unchanged since written, removing` : `compaction ${k}: edited by you or already gone, kept`);
    if (ownedKeys.length) {
      next ??= structuredClone(settings);
      for (const k of ownedKeys) dropOverride(next, k);
    }
    if (next) say(unifiedDiff(path.basename(settingsFile), settingsText, toJson(next)));
    const permText = readText(permFile);
    const permRecorded = isObj(managed.files) ? managed.files[permFile] : undefined;
    let dropPerm = false;
    if (permText === null) say("permission-system config: none present");
    else if (permRecorded && permRecorded === (() => { try { return sha(parseJsonObject(permText, permFile)); } catch { return null; } })()) {
      dropPerm = true;
      say(`permission-system config: unchanged since written, removing ${permFile}`);
    } else say("permission-system config: not ours or edited by hand, kept");
    if (!next && !dropPerm && !Object.keys(derived).length) {
      say("pi-foreman: up to date, nothing to remove.");
      say(`The package itself stays installed; to remove it run: ${removeLine}`);
      return;
    }
    say("kept: foreman.json, backups, intercom config, and any overlay (use `pi remove <source>` for the overlay).");
    if (dry) return;
    backup();
    if (next) {
      const fresh = parseJsonObject(readText(settingsFile), settingsFile) ?? {};
      if (Object.keys(cur).length > 0 && record && sha(cur) === record.subagentsHash) dropManaged(fresh);
      for (const k of ownedKeys) if (reserveOf(fresh, k) === derived[k]) dropOverride(fresh, k);
      writeFile(settingsFile, toJson(fresh));
    }
    delete managed.entries[settingsFile];
    if (dropPerm) {
      const file = `${permFile}.bak-${timestamp()}`;
      fs.copyFileSync(permFile, file);
      say(`  backup: ${file}`);
      fs.unlinkSync(permFile);
      delete managed.files[permFile];
    }
    if (managedText !== null) writeFile(managedFile, toJson(managed));
    say("pi-foreman: removed managed entries.");
    say(`The package itself stays installed; to remove it run: ${removeLine}`);
  }

  // ------------------------------------------------------------ develop
  /** <checkout>/.pi/settings.json: load this checkout and switch the installed pi-foreman package off in this directory. */
  function developSettings() {
    const file = path.join(ROOT, ".pi", "settings.json");
    const globalFile = path.join(agentDir, "settings.json");
    const globalPk = (parseJsonObject(readText(globalFile), globalFile) ?? {}).packages;
    const inst = (Array.isArray(globalPk) ? globalPk : []).find(isRemoteForeman);
    const text = readText(file);
    const cur = parseJsonObject(text, file) ?? {};
    const others = (Array.isArray(cur.packages) ? cur.packages : []).filter((e) => !isForemanEntry(e, path.dirname(file)));
    const override = inst ? [{ source: entrySource(inst), extensions: [], skills: [], prompts: [], themes: [] }] : [];
    const next = { ...cur, packages: ["..", ...override, ...others] };
    let changed = false;
    if (text !== null && canonical(next) === canonical(cur)) say(`develop: ${file} already loads this checkout`);
    else {
      changed = true;
      say(`develop: ${dry ? "would write" : "writing"} ${file}${inst ? ` (overrides the installed ${entrySource(inst)} here)` : ""}`);
      say(unifiedDiff(".pi/settings.json", text, toJson(next)));
      if (!dry) writeFile(file, toJson(next));
    }
    say("  note: project packages load only after the project is trusted: answer Pi's trust prompt, or run `pi -a` (--approve) headless. Run `npm install` in the checkout once so the bundled packages load.");
    return changed;
  }

  // ------------------------------------------------------------ install
  async function install() {
    if (!(Array.isArray(settings.packages) ? settings.packages : []).some((e) => isForemanEntry(e, baseDir)) && !opts.develop) {
      throw new Fatal(`pi-foreman is not installed as a Pi package. Run:\n${FOREMAN_INSTALL}${opts.project ? " -l" : ""}`);
    }
    const py = resolvePython(agentDir);
    say(`  python ${py.version.join(".")} via ${py.source}: ${py.executable}`);
    let anyChange = false;

    // The recorded profile is the merged user-plus-overlay value (no project layer).
    const knownProfiles = Object.keys(loadProfiles().profiles);
    const mergedProfile = runConfigCli(py, ["merged", "--json", "--agent-dir", agentDir], projectDir).data?.config?.profile;
    const recorded = typeof mergedProfile === "string" && mergedProfile ? mergedProfile : null;
    if (recorded && !knownProfiles.includes(recorded)) {
      say(`WARN profile ${recorded} unknown (valid: ${knownProfiles.join(", ")}); fix with: foreman setup --profile <name>`);
    }
    const curText = readText(foremanFile);
    const template = toJson({ version: 1, providers: {} });
    let curCfg = { version: 1, providers: {} };
    let parseErr = null;
    if (curText !== null) {
      try {
        curCfg = parseJsonObject(curText, foremanFile);
      } catch (err) {
        parseErr = err;
      }
    }

    // choices: flags, or the picker (terminal only, first run or --pick)
    const st = pickerState();
    const hasFlags = !!(opts.profile || opts.enable.length || opts.disable.length || opts.addon.length);
    let request = { profile: opts.profile, enable: opts.enable, disable: opts.disable };
    let addonIds = [...opts.addon];
    let diffShown = false;
    if (st.allowed && !hasFlags && (recorded === null || opts.pick)) {
      if (parseErr) throw parseErr;
      const picked = await runPicker({ currentText: curText, currentConfig: curCfg, recorded, installed: addonsInstalled(), project: opts.project });
      if (!picked) {
        say("nothing written");
        return;
      }
      request = { profile: picked.profile, enable: picked.enable, disable: picked.disable };
      addonIds = picked.addons;
      diffShown = true;
    } else if (!request.profile && recorded === null) say(NO_PROFILE_HINT);

    // foreman.json first, so the generator and the permission render below see it (on --dry-run nothing is written, so they
    // reflect the file on disk, one run behind the diff shown here)
    if (!request.profile && !request.enable.length && !request.disable.length) {
      if (curText === null) {
        anyChange = true;
        say(`foreman.json: absent, ${dry ? "would create" : "creating"} a template`);
        if (dry) say(unifiedDiff("foreman.json", null, template));
        else writeFile(foremanFile, template);
      } else say("foreman.json: present, left alone");
    } else {
      if (parseErr) throw parseErr;
      const plan = planChanges(curCfg, request);
      if (plan.errors.length) throw new Fatal(plan.errors.join("\n"), 2);
      for (const c of plan.changes) {
        const leaves = c.leaves.map((l) => `${l.path}=${JSON.stringify(l.value)}`).join(", ");
        say(`  feature ${c.feature} -> ${c.state}${leaves ? ` (${leaves})` : ""}${c.notes.length ? `: ${c.notes.join("; ")}` : ""}`);
      }
      if (plan.relaxations.length) say(`WARN safety relaxations on: ${plan.relaxations.join(", ")}`);
      const nextText = toJson(plan.config);
      if (curText !== null && canonical(plan.config) === canonical(curCfg)) say(`foreman.json: up to date${request.profile ? ` (profile ${request.profile})` : ""}`);
      else {
        say(`foreman.json: ${dry ? "would write" : "writing"} ${curText === null ? "a new file" : "changes"}`);
        if (!diffShown) say(unifiedDiff("foreman.json", curText, nextText));
        guardUserConfig(py, curText === null ? template : null, nextText);
        anyChange = true;
        if (!dry) {
          if (curText !== null) {
            const file = `${foremanFile}.bak-${timestamp()}`;
            fs.copyFileSync(foremanFile, file);
            say(`  backup: ${file}`);
          }
          fs.mkdirSync(path.dirname(foremanFile), { recursive: true });
          const beside = `${foremanFile}.tmp-${process.pid}`;
          fs.writeFileSync(beside, nextText);
          fs.renameSync(beside, foremanFile);
        }
      }
    }

    // packages: pi-foreman installs itself (and bundles its dependencies); here we migrate and filter
    const list0 = Array.isArray(settings.packages) ? settings.packages : [];
    // A --develop override ({source, extensions: []}) silences the installed copy; it does not make ".." stale.
    const isOverride = (e) => !!e && typeof e === "object" && Array.isArray(e.extensions) && e.extensions.length === 0;
    const hasRemote = list0.some((e) => isRemoteForeman(e) && !isOverride(e));
    // Leftover top-level copies of the bundled packages (or an old local-path entry next to the git/npm one)
    // would load a second time, and a duplicate tool name stops Pi at start: remove them.
    // ... unless the bundled copies do not resolve under this package root: then the top-level copies are the only ones that load.
    const missing = missingBundledEntries(ROOT);
    if (missing.length) {
      say(`  missing bundled entries under ${ROOT}: run npm ci in the checkout (${missing.join(", ")}); keeping the top-level package copies`);
    }
    const stale = list0.filter((e) => (isBundledEntry(e) && !missing.length) || (hasRemote && isLocalForeman(e, baseDir)));
    const removeArgs = stale.map((e) => {
      const src = entrySource(e);
      return ["remove", isLocalSource(src) ? resolveLocal(src, baseDir) : src, ...(opts.project ? ["-l"] : [])];
    });
    for (const e of stale) say(`  package ${entrySource(e)}: ${dry ? "would remove" : "removing"} (bundled with pi-foreman now; a second copy stops Pi at start)`);
    if (removeArgs.length) anyChange = true;
    const want = [];
    for (const p of lock.packages) if (p.mode === "bundled") say(`  package ${p.name}@${p.version}: bundled with pi-foreman${p.name === INTERCOM && opts.noIntercom ? " (filtered out, --no-intercom)" : ""}`);
    if (opts.overlay) want.push({ spec: opts.overlay, label: `overlay ${opts.overlay}` });
    const todo = want.filter((w) => !isRecorded(settings, w.spec));
    for (const w of want) say(`  package ${w.label}: ${todo.includes(w) ? "to install" : "already recorded"}`);
    const installArgs = todo.map((w) => ["install", w.spec, ...(opts.project ? ["-l"] : [])]);
    // add-ons: only on consent, queued before the fresh settings re-read so setup never overwrites the packages entry the install adds
    const addonRegistry = loadAddons().addons;
    const already = addonsInstalled();
    const addonNew = [];
    for (const id of addonIds) {
      const a = addonRegistry.find((x) => x.id === id);
      const have = already.find((i) => i.id === id);
      if (have) say(`  add-on ${id}: already installed (${have.source}), no command`);
      else {
        const spec = `npm:${a.package}@${a.version}`;
        say(`  add-on ${id}: to install (${spec})`);
        installArgs.push(["install", spec, ...(opts.project ? ["-l"] : [])]);
        addonNew.push({ id, spec });
      }
      for (const [k, v] of Object.entries(a.env ?? {})) say(`  add-on ${id}: set ${k}=${v} permanently in your shell profile; Pi reads it when it starts, not at install.`);
    }
    if (installArgs.length) anyChange = true;
    const planned = [...list0.filter((e) => !stale.includes(e)), ...todo.map((w) => w.spec)];
    // --no-intercom: filter on the pi-foreman entry
    const applyFilter = (pk) => (Array.isArray(pk) && opts.noIntercom ? pk.map((e) => (isForemanEntry(e, baseDir) ? withoutIntercom(e) : e)) : pk);
    const filtered = canonical(applyFilter(planned)) !== canonical(planned) ? applyFilter(planned) : null;
    if (filtered) {
      anyChange = true;
      say(`packages: ${dry ? "would filter" : "filtering"} pi-intercom out of the pi-foreman entry (--no-intercom)`);
      say(unifiedDiff(path.basename(settingsFile), toJson({ ...settings, packages: planned }), toJson({ ...settings, packages: filtered })));
    }
    // load order: pi-foreman before pi-claude-bridge
    const afterFilter = filtered ?? planned;
    const reordered = foremanBeforeBridge(afterFilter, baseDir);
    if (reordered) {
      anyChange = true;
      say(`packages: ${dry ? "would move" : "moving"} pi-foreman before pi-claude-bridge, so its config-drift check runs before the bridge's compaction and branch summaries`);
      say(unifiedDiff(path.basename(settingsFile), toJson({ ...settings, packages: afterFilter }), toJson({ ...settings, packages: reordered })));
    }
    const finalPackages = reordered ?? afterFilter;
    if (!opts.noIntercom) {
      const icFile = path.join(agentDir, "intercom", "config.json");
      const icText = readText(icFile);
      if (icText === null) {
        anyChange = true;
        say(`intercom config: absent, ${dry ? "would create" : "creating"} ${icFile}`);
        if (dry) say(unifiedDiff("intercom/config.json", null, toJson(INTERCOM_CONFIG)));
        else writeFile(icFile, toJson(INTERCOM_CONFIG));
      } else {
        let ic = null;
        try {
          ic = parseJsonObject(icText, icFile);
        } catch (err) {
          say(`  warning: ${err.message}`);
        }
        const risky = ic ? INTERCOM_RISKY_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(ic, k)) : [];
        say("intercom config: present, left alone");
        if (risky.length) say(`  warning: ${icFile} sets ${risky.join(", ")} (brokerCommand/brokerArgs choose the program pi-intercom starts as its broker, crossMachine enables sends over SSH); fine only if you set them on purpose.`);
      }
    }
    if (opts.project) say("  note: project packages load only after the project is trusted; headless runs need `pi --approve` (or `-a`).");

    /**
     * Pi `compaction.modelOverrides["<provider>/<id>"].reserveTokens` for the covered models (role map incl. strong and idle,
     * review and security rungs, Pi's default model, `ranks` matches in Pi's registry or live model list, overlay
     * `providers.<p>.models`), derived with compactionPoint(). Ownership is recorded in managed.json (`compactionDerived`): a
     * value equal to the record is ours, any other is the user's and stays. Model data: declared, else the registry file, else
     * (providers without a registry file) tiers from the `modelDataFrom` base and the window from `pi --list-models`.
     * Phases: registry probes, at most one listing spawn, then the key loop; every covered or recorded key gets one line.
     */
    function planCompaction() {
      const out = { changed: false, recordChanged: false, record: {}, lines: [], apply: () => {} };
      const derived0 = isObj(record?.compactionDerived) ? record.compactionDerived : {};
      out.record = { ...derived0 };
      if (!pointModule || !dataModule) {
        out.lines.push("  warning: compaction: extensions/core-adapter/compaction-point.mjs or pi-model-data.mjs could not be loaded; compaction overrides skipped");
        return out;
      }
      const { compactionPoint } = pointModule;
      const cfg = runConfigCli(py, ["validate", "--json", "--agent-dir", agentDir, "--project-dir", projectDir, ...(opts.project ? ["--trusted-project"] : [])], projectDir).data?.config;
      if (!isObj(cfg)) {
        out.lines.push("  warning: compaction: config unreadable, overrides left as they are");
        return out;
      }
      const providers = isObj(cfg.providers) ? cfg.providers : {};
      const maxTokens = typeof cfg.compaction?.maxTokens === "number" ? cfg.compaction.maxTokens : null;
      let globalSettings = {};
      let globalDerived = {};
      if (opts.project) {
        const globalFile = path.join(agentDir, "settings.json");
        try {
          globalSettings = parseJsonObject(readText(globalFile), globalFile) ?? {};
        } catch {
          globalSettings = {};
        }
        const gr = managed.entries[globalFile];
        if (isObj(gr) && isObj(gr.compactionDerived)) globalDerived = gr.compactionDerived;
      }
      // what Pi resolves for the model today, leaving out values this tool wrote earlier
      const own = (obj, owned, key) => {
        const v = reserveOf(obj, key);
        return v !== undefined && v === owned[key] ? undefined : v;
      };
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const effectiveReserve = (key) =>
        num(own(settings, derived0, key)) ?? num(own(globalSettings, globalDerived, key)) ??
        num(settings.compaction?.reserveTokens) ?? num(globalSettings.compaction?.reserveTokens) ?? PI_DEFAULT_RESERVE;
      const keepOf = (obj, key) => num(obj.compaction?.modelOverrides?.[key]?.keepRecentTokens);
      const effectiveKeep = (key) =>
        keepOf(settings, key) ?? keepOf(globalSettings, key) ??
        num(settings.compaction?.keepRecentTokens) ?? num(globalSettings.compaction?.keepRecentTokens) ?? PI_DEFAULT_KEEP_RECENT;

      // registry: looked up lazily, one warning on any failure
      let dataDir;
      let registryFailed = false;
      const registryWarn = (why) => {
        if (registryFailed) return;
        registryFailed = true;
        out.lines.push(`  warning: compaction: Pi model registry unavailable (${why}); registry models skipped, overrides for them left as they are`);
      };
      const registry = new Map();
      const registryFile = new Map();
      const registryModels = (provider) => {
        if (registry.has(provider)) return registry.get(provider);
        let models = new Map();
        if (dataDir === undefined) {
          const r = dataModule.piModelDataDir();
          dataDir = r.dir ?? null;
          if (r.error) registryWarn(r.error);
        }
        if (dataDir) {
          try {
            registryFile.set(provider, fs.existsSync(path.join(dataDir, `${provider}.json`)));
            models = readProviderModels(dataDir, provider);
          } catch (err) {
            registryWarn(`${provider}.json: ${err.message}`);
          }
        }
        registry.set(provider, models);
        return models;
      };
      const hasRegistry = (p) => {
        registryModels(p);
        return registryFile.get(p) === true;
      };
      const providerOf = (key) => {
        const i = key.indexOf("/");
        return i > 0 ? key.slice(0, i) : null;
      };
      const baseOf = (p) => {
        const b = providers[p]?.modelDataFrom;
        if (typeof b === "string" && b) return b;
        return Object.hasOwn(BUILTIN_MODEL_DATA_FROM, p) ? BUILTIN_MODEL_DATA_FROM[p] : null;
      };

      // coverage that needs no model list
      const covered = new Set();
      const declared = new Map();
      const rankProviders = [];
      const addRef = (ref, bareOf) => {
        if (typeof ref !== "string" || !ref) return;
        const r = stripLevel(ref);
        if (r.indexOf("/") > 0) covered.add(r);
        else if (bareOf) covered.add(`${bareOf}/${r}`);
      };
      for (const [p, block] of Object.entries(providers)) {
        if (!isObj(block)) continue;
        for (const [id, m] of Object.entries(isObj(block.models) ? block.models : {})) {
          declared.set(`${p}/${id}`, m);
          covered.add(`${p}/${id}`);
        }
        for (const role of Object.values(isObj(block.roles) ? block.roles : {})) {
          if (!isObj(role)) continue;
          for (const ref of [role.model, role.strong?.model, role.idle?.model]) addRef(ref);
        }
        addRef(block.review?.model, p);
        const ranks = Array.isArray(block.ranks) ? block.ranks.filter((r) => isObj(r) && typeof r.match === "string") : [];
        if (ranks.length) rankProviders.push([p, ranks]);
      }
      addRef(cfg.ladder?.reviewerClimb?.securityRung);
      // Pi's default model, each field resolved like Pi's merged settings (the target file, then the global one)
      const settingField = (k) => [settings[k], globalSettings[k]].find((v) => typeof v === "string" && v);
      if (settingField("defaultProvider") && settingField("defaultModel")) covered.add(`${settingField("defaultProvider")}/${settingField("defaultModel")}`);
      const recordedKeys = Object.keys(derived0);

      // phase 1: registry probes (covered, recorded and rank providers, and their bases), so registryFailed is final
      const probe = new Set(rankProviders.map(([p]) => p));
      for (const key of [...covered, ...recordedKeys]) {
        const p = providerOf(key);
        if (p) probe.add(p);
      }
      for (const p of [...probe]) {
        const b = baseOf(p);
        if (b) probe.add(b);
      }
      for (const p of probe) registryModels(p);

      // phase 2: at most one live listing
      const needsListing = (key) => {
        const p = providerOf(key);
        return p !== null && !declared.has(key) && !hasRegistry(p);
      };
      let listing = null;
      if (!registryFailed && ([...covered, ...recordedKeys].some(needsListing) || rankProviders.some(([p]) => !hasRegistry(p)))) {
        listing = readModelListing(pi, { agentDir, cwd: projectDir });
        if (listing.why) out.lines.push(`  warning: compaction: Pi's model list unavailable (${listing.why}); keys that need it skipped`);
      }

      // phase 3: rank coverage, then the key loop
      for (const [p, ranks] of rankProviders) {
        const ids = hasRegistry(p) ? registryModels(p).keys() : (listing?.rows?.get(p)?.keys() ?? []);
        for (const id of ids) {
          if (ranks.some((r) => globMatches(r.match, r.match.includes("/") ? `${p}/${id}` : id))) covered.add(`${p}/${id}`);
        }
      }

      const actions = [];
      const keys = new Set([...covered, ...recordedKeys]);
      for (const key of [...keys].sort()) {
        const cur = num(reserveOf(settings, key));
        const rec = derived0[key];
        const p = providerOf(key);
        const id = key.slice(key.indexOf("/") + 1);
        const line = (text) => out.lines.push(`compaction ${key}: ${text}`);
        let r = null;
        let noTiers = false;
        if (covered.has(key)) {
          let model;
          let alsoBase = "";
          if (declared.has(key)) model = declared.get(key);
          else if (registryFailed) continue;
          else if (hasRegistry(p)) {
            model = registryModels(p).get(id);
            if (!model) {
              line(`skipped, no model data; declare providers.${p}.models.${id}`);
              continue;
            }
          } else {
            alsoBase = ` or providers.${p}.modelDataFrom`;
            if (listing.why) {
              line("skipped, Pi's model list unavailable");
              continue;
            }
            const cell = listing.rows.get(p)?.get(id);
            if (cell === undefined) {
              line("skipped, not in Pi's model list (provider not logged in, its extension not loaded, or the project untrusted); log in and re-run setup");
              continue;
            }
            const base = baseOf(p);
            const baseModel = base ? registryModels(base).get(id) : undefined;
            const window = base && !baseModel ? null : windowFromListing(cell, baseModel?.contextWindow);
            if (window === "inexact") {
              line(`skipped, window ${cell} is not exact; declare providers.${p}.models.${id}`);
              continue;
            }
            model = { contextWindow: window, tiers: baseModel?.tiers ?? [] };
            noTiers = !base;
          }
          r = compactionPoint(
            { contextWindow: model.contextWindow, tiers: model.tiers },
            { maxTokens, effectiveReserve: effectiveReserve(key), effectiveKeepRecent: effectiveKeep(key) },
          );
          if (r.reason === "unknown-window") {
            line(`skipped, no model data; declare providers.${p}.models.${id}${alsoBase}`);
            continue;
          }
        } else {
          if (registryFailed) continue;
          if (needsListing(key) && (listing.why || !listing.rows.has(p))) {
            line(`recorded reserveTokens ${rec} kept (${listing.why ? "Pi's model list unavailable" : `${p} is not in Pi's model list`})`);
            continue;
          }
        }
        const tail = noTiers ? " (no price tiers known)" : "";
        if (r?.write) {
          if (cur === undefined || cur === rec) {
            if (cur !== r.reserve) {
              actions.push({ key, set: r.reserve });
              line(`reserveTokens ${cur ?? "unset"} -> ${r.reserve} (compacts at ${r.point})${tail}`);
            } else line(`reserveTokens ${cur}, unchanged (compacts at ${r.point})${tail}`);
            out.record[key] = r.reserve;
          } else {
            line(`reserveTokens ${cur}, kept: user value`);
            delete out.record[key];
          }
          continue;
        }
        // no override wanted
        const own = rec !== undefined && cur === rec;
        if (r?.reason === "below-minimum") {
          out.lines.push(`  warning: compaction: ${key}: the point ${r.point} is below keepRecentTokens + 20000; no override written${own ? "; removing the earlier override" : ""}`);
        } else if (rec === undefined) line(`no override needed (Pi already compacts at ${r.point})${tail}`);
        else if (own) line(`reserveTokens ${cur} no longer needed, removing`);
        else if (cur === undefined) line("recorded override already gone");
        else line(`reserveTokens ${cur}, kept: user value`);
        if (own) actions.push({ key, drop: true });
        delete out.record[key];
      }
      out.changed = actions.length > 0;
      out.recordChanged = canonical(out.record) !== canonical(derived0);
      out.apply = (obj) => {
        for (const a of actions) {
          if (a.drop) {
            if (reserveOf(obj, a.key) === derived0[a.key]) dropOverride(obj, a.key);
          } else setOverride(obj, a.key, a.set);
        }
      };
      return out;
    }

    // settings merge
    const gen = runConfigCli(py, ["generate-subagents", "--json", "--agent-dir", agentDir, "--project-dir", projectDir], projectDir);
    if (!gen.data || !isObj(gen.data.subagents)) throw new Fatal(`generate-subagents failed (exit ${gen.code}): ${gen.stderr || "no JSON output"}`);
    const wanted = pick(gen.data.subagents);
    const errors = Array.isArray(gen.data.errors) ? gen.data.errors : [];
    const warnings = Array.isArray(gen.data.warnings) ? gen.data.warnings : [];
    const cur = isObj(settings.subagents) ? pick(settings.subagents) : {};
    const same = MANAGED_KEYS.every((k) => canonical(cur[k] ?? null) === canonical(wanted[k] ?? null));
    const hasCur = Object.keys(cur).length > 0;
    const applyWanted = (obj) => {
      if (!isObj(obj.subagents)) obj.subagents = {};
      for (const k of MANAGED_KEYS) if (wanted[k] !== undefined) obj.subagents[k] = wanted[k];
    };
    const comp = planCompaction();
    let next = settings;
    if (!same || comp.changed) {
      anyChange = true;
      next = structuredClone(settings);
      if (!same) applyWanted(next);
      comp.apply(next);
    }
    if (comp.recordChanged) anyChange = true;
    if (!same) {
      if (hasCur && record && sha(cur) !== record.subagentsHash) say("subagents block: edited by hand since the last install; backing it up and overwriting");
      else if (hasCur && !record) say("subagents block: present but not recorded as ours; backing it up and overwriting");
      else say("subagents block: writing the generated block");
    } else say("subagents block: in sync");
    for (const l of comp.lines) say(l);
    if (next !== settings) {
      say(unifiedDiff(path.basename(settingsFile), settingsText, toJson(next)));
      if (installArgs.length) say("  (the diff leaves out `packages`, which `pi install` edits itself)");
    }
    const needRecord = !record || record.subagentsHash !== sha(pick(next.subagents));
    if (needRecord) anyChange = true;

    for (const e of errors) say(`  generate-subagents: ${e}`);
    for (const w of warnings) say(`  warning: ${w}`);
    // permission-system config, generated from the baseline plus safety.permissions (L1 -> L3 -> L2)
    const pg = runConfigCli(py, ["render", "--agent-dir", agentDir], projectDir, "permissions_gen.py");
    if (!pg.data || !isObj(pg.data.config)) throw new Fatal(`permissions_gen.py failed (exit ${pg.code}): ${pg.stderr || "no JSON output"}`);
    const permWanted = pg.data.config;
    const permText = readText(permFile);
    let permCur = null;
    let permBroken = false;
    try {
      permCur = parseJsonObject(permText, permFile);
    } catch {
      permBroken = true;
    }
    const permRecorded = isObj(managed.files) ? managed.files[permFile] : undefined;
    const permSame = !permBroken && permCur !== null && canonical(permCur) === canonical(permWanted);
    const permHash = sha(permWanted);
    if (permSame) say("permission-system config: in sync");
    else {
      anyChange = true;
      if (permText === null) say(`permission-system config: absent, ${dry ? "would write" : "writing"} ${permFile}`);
      else {
        const edited = permBroken || !permRecorded || permRecorded !== sha(permCur);
        say(`permission-system config: ${edited ? "edited by hand or not recorded as ours" : "out of date"}; backing it up and overwriting. The installer owns this file: put your own rules in foreman.json (safety.permissions).`);
      }
      say(unifiedDiff("extensions/pi-permission-system/config.json", permText, toJson(permWanted)));
    }
    const permNeedRecord = !isObj(managed.files) || managed.files[permFile] !== permHash;
    if (permNeedRecord) anyChange = true;
    for (const w of pg.data.warnings || []) say(`  warning: ${w}`);

    // pi-subagents worktree setup hook: a plain node_modules copy instead of the symlink (scripts/foreman_worktree_setup.py)
    const hookFile = path.join(agentDir, "extensions", "subagent", "config.json");
    const hookLauncher = path.join(ROOT, "bin", "foreman-worktree-setup");
    let hookNext = null;
    if (WIN) say("worktree setup hook: not registered on Windows (pi-subagents cannot spawn a script hook without a shell); the builder prompt and /foreman doctor guard node_modules links instead");
    else {
      const hookText = readText(hookFile);
      const hookCur = parseJsonObject(hookText, hookFile) ?? {};
      const ours = (v) => typeof v === "string" && /[\\/]bin[\\/]foreman-worktree-setup$/.test(v);
      const hookSet = typeof hookCur.worktreeSetupHook === "string" && hookCur.worktreeSetupHook.trim() !== "";
      const hookStale = hookSet && ours(hookCur.worktreeSetupHook) && hookCur.worktreeSetupHook !== hookLauncher && !fs.existsSync(hookCur.worktreeSetupHook);
      if (hookSet && !hookStale) say(`worktree setup hook: already set to ${hookCur.worktreeSetupHook}, left alone`);
      else {
        hookNext = { ...hookCur, worktreeSetupHook: hookLauncher };
        if (hookCur.worktreeSetupHookTimeoutMs === undefined) hookNext.worktreeSetupHookTimeoutMs = WORKTREE_HOOK_TIMEOUT_MS;
        anyChange = true;
        say(`worktree setup hook: ${dry ? "would write" : "writing"} worktreeSetupHook=${hookLauncher} and worktreeSetupHookTimeoutMs=${hookNext.worktreeSetupHookTimeoutMs} to ${hookFile}`);
        say(unifiedDiff("extensions/subagent/config.json", hookText, toJson(hookNext)));
      }
    }

    if (dry) {
      for (const a of [...removeArgs, ...installArgs]) say(`would run: pi ${a.join(" ")}`);
      if (needRecord || permNeedRecord) say(`would record the managed hash in ${managedFile}`);
      if (comp.recordChanged) say(`would update the compactionDerived record in ${managedFile}`);
    } else if (anyChange) {
      if (removeArgs.length || installArgs.length || !same || filtered || reordered || comp.changed) backup();
      for (const a of [...removeArgs, ...installArgs]) runOrDie(a);
      for (const a of addonNew) {
        if (!isObj(managed.addons)) managed.addons = {};
        managed.addons[a.id] = { spec: a.spec, installedAt: new Date().toISOString() };
      }
      let finalBlock = pick(next.subagents);
      if (!same || filtered || reordered || comp.changed) {
        // pi edits `packages` in the same file, so merge into what is on disk now
        const fresh = parseJsonObject(readText(settingsFile), settingsFile) ?? {};
        if (!same) applyWanted(fresh);
        comp.apply(fresh);
        const filteredNow = applyFilter(fresh.packages);
        fresh.packages = foremanBeforeBridge(filteredNow, baseDir) ?? filteredNow;
        writeFile(settingsFile, toJson(fresh));
        if (!same) finalBlock = pick(fresh.subagents);
      }
      managed.entries[settingsFile] = { ...(isObj(managed.entries[settingsFile]) ? managed.entries[settingsFile] : {}), subagentsHash: sha(finalBlock) };
      if (Object.keys(comp.record).length) managed.entries[settingsFile].compactionDerived = comp.record;
      else delete managed.entries[settingsFile].compactionDerived;
      if (!permSame) {
        if (permText !== null) {
          const file = `${permFile}.bak-${timestamp()}`;
          fs.copyFileSync(permFile, file);
          say(`  backup: ${file}`);
        }
        writeFile(permFile, toJson(permWanted));
      }
      if (hookNext) writeFile(hookFile, toJson(hookNext));
      if (!isObj(managed.files)) managed.files = {};
      managed.files[permFile] = permHash;
      writeFile(managedFile, toJson(managed));
    }

    // validation and hints
    const v = runConfigCli(py, ["validate", "--json", "--agent-dir", agentDir, "--project-dir", projectDir], projectDir).data;
    if (v) {
      for (const w of v.warnings || []) say(`  foreman.json warning: ${w}`);
      for (const e of v.errors || []) say(`  foreman.json error: ${e}`);
      const providers = v.config && v.config.providers;
      if (isObj(providers) && Object.keys(providers).length === 0) {
        say(`  no provider mapped yet: add one under "providers" in ${foremanFile} (README, section Install), then re-run.`);
      }
    }
    if (errors.length) say(`  some roles are unresolved; only the resolvable part was written. Edit ${foremanFile}.`);

    if (finalPackages.some(isBridgeEntry)) say(BRIDGE_HINT.replace("<agent dir>", agentDir));
    const present = addonsInstalled();
    for (const a of addonRegistry) {
      if (present.some((i) => i.id === a.id) || addonNew.some((n) => n.id === a.id)) continue;
      say(`optional add-on ${a.id}: ${a.purpose} Spec npm:${a.package}@${a.version}. ${a.clashes.join(" ")} Install with: foreman setup --addon ${a.id}`);
    }
    if (opts.develop && developSettings()) anyChange = true;
    if (!anyChange) say("pi-foreman: up to date, nothing to change.");
    else if (dry) say("pi-foreman: dry run complete, nothing written.");
    else say("pi-foreman: done. Run /foreman doctor inside pi to check the setup.");
  }
}

// Run only as the entry point, so the tests can import npmCiReason.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === path.join(ROOT, "setup.mjs")) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Fatal) {
      (err.code === 0 ? console.log : console.error)(err.message);
      process.exitCode = err.code;
    } else {
      console.error(err && err.stack ? err.stack : String(err));
      process.exitCode = 1;
    }
  }
}
