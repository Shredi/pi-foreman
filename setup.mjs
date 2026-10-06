#!/usr/bin/env node
// pi-foreman installer (design section 11). Plain Node >= 22 ESM, no dependencies.
//   node setup.mjs [--dry-run] [--project] [--overlay npm:<pkg>@<ver>] [--no-intercom] [--remove] [--agent-dir <dir>]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === "win32";
const MANAGED_KEYS = ["agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"]; // same keys as /foreman doctor
const MIN_PY = [3, 9];
const PROBE_CODE = "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable)";
const OVERLAY_RE = /^npm:(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const USAGE = "Usage: node setup.mjs [--dry-run] [--project] [--overlay npm:<pkg>@<ver>] [--no-intercom] [--remove] [--agent-dir <dir>]\n  --no-intercom  do not install pi-intercom (installed by default) and do not write its config";
const INTERCOM = "pi-intercom";
// Written once when absent (never overwritten): wake on every inbound message, the human's input first.
const INTERCOM_CONFIG = { inboundTrigger: "always", busyDelivery: "human-first" };
// Keys that change the program pi-intercom starts or enable sends over SSH: trusted overrides, warned about.
const INTERCOM_RISKY_KEYS = ["brokerCommand", "brokerArgs", "crossMachine"];

class Fatal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const say = (s = "") => console.log(s);

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const o = { dryRun: false, project: false, remove: false, overlay: null, agentDir: null, noIntercom: false };
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
    else if (flag === "--overlay") o.overlay = value();
    else if (flag === "--agent-dir") o.agentDir = value();
    else if (flag === "--help" || flag === "-h") throw new Fatal(USAGE, 0);
    else throw new Fatal(`Unknown argument: ${argv[i]}\n${USAGE}`, 2);
  }
  if (o.overlay !== null && !OVERLAY_RE.test(o.overlay)) {
    throw new Fatal(`--overlay needs an exact version, e.g. npm:@scope/pkg@1.2.3 (got "${o.overlay}"). Ranges and tags are refused.`, 2);
  }
  if (o.overlay && o.remove) throw new Fatal("--overlay and --remove cannot be combined.", 2);
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

function unifiedDiff(label, before, after) {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const ctx = 2;
  const from = Math.max(0, s - ctx);
  const aEnd = Math.min(a.length, a.length - e + ctx);
  const bEnd = Math.min(b.length, b.length - e + ctx);
  const lines = [`--- ${before === null ? "/dev/null" : `a/${label}`}`, `+++ b/${label}`, `@@ -${a.length ? from + 1 : 0},${aEnd - from} +${b.length ? from + 1 : 0},${bEnd - from} @@`];
  for (let i = from; i < s; i++) lines.push(` ${a[i]}`);
  for (let i = s; i < a.length - e; i++) lines.push(`-${a[i]}`);
  for (let i = s; i < b.length - e; i++) lines.push(`+${b[i]}`);
  for (let i = a.length - e; i < aEnd; i++) lines.push(` ${a[i]}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- Pi

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
      const m = /%dp0%[\\/]+([^"\r\n]+?\.(?:c|m)?js)"/i.exec(fs.readFileSync(cmd, "utf8"));
      const js = m ? path.resolve(dir, m[1]) : null;
      if (js && fs.existsSync(js)) return { command: process.execPath, prefix: [js] };
      throw new Fatal(`Found ${cmd} but could not read the script it launches. Set PI_FOREMAN_PI_BIN to pi's cli.js (inside the @earendil-works/pi-coding-agent package) and re-run.`);
    }
  }
  throw new Fatal("`pi` was not found on PATH. Install Pi first (npm install -g @earendil-works/pi-coding-agent).");
}

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

/** Same order as extensions/core-adapter/python.ts. */
function pythonCandidates(configPath, envPath) {
  const out = [];
  if (configPath && configPath.trim()) out.push({ command: configPath.trim(), args: [], source: "python.path" });
  if (envPath && envPath.trim()) out.push({ command: envPath.trim(), args: [], source: "PI_FOREMAN_PYTHON" });
  if (WIN) out.push({ command: "py", args: ["-3"], source: "py -3" }, { command: "python", args: [], source: "python" });
  else out.push({ command: "python3", args: [], source: "python3" }, { command: "python", args: [], source: "python" });
  return out;
}

function isStoreStub(file) {
  return WIN && !!file && path.win32.basename(path.win32.dirname(file)).toLowerCase() === "windowsapps";
}

function readPythonPathHint(agentDir) {
  let value = null;
  for (const file of [path.join(ROOT, "config", "foreman.defaults.json"), path.join(agentDir, "foreman.json")]) {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isObj(v) && isObj(v.python) && v.python.path !== undefined) value = v.python.path;
    } catch {
      /* missing or unreadable: ignore here, validate reports it later */
    }
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function resolvePython(agentDir) {
  const rejected = [];
  for (const c of pythonCandidates(readPythonPathHint(agentDir), process.env.PI_FOREMAN_PYTHON)) {
    const label = `${c.source} (${[c.command, ...c.args].join(" ")})`;
    if (isStoreStub(c.command)) {
      rejected.push(`${label}: Windows Store alias stub`);
      continue;
    }
    const r = spawnSync(c.command, [...c.args, "-E", "-c", PROBE_CODE], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (r.error || r.status !== 0) {
      rejected.push(`${label}: ${r.error ? r.error.message : `exit ${r.status}`}`);
      continue;
    }
    const lines = (r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const m = /^(\d+)\.(\d+)$/.exec(lines[0] || "");
    if (!m) {
      rejected.push(`${label}: unreadable version output`);
      continue;
    }
    const ver = [Number(m[1]), Number(m[2])];
    if (ver[0] < MIN_PY[0] || (ver[0] === MIN_PY[0] && ver[1] < MIN_PY[1])) {
      rejected.push(`${label}: Python ${ver.join(".")} is older than 3.9`);
      continue;
    }
    const executable = lines[1] || c.command;
    if (isStoreStub(executable)) {
      rejected.push(`${label}: Windows Store alias stub`);
      continue;
    }
    return { executable, version: ver, source: c.source };
  }
  const how = WIN
    ? "Windows: install Python 3.9+ from https://www.python.org/downloads/ (or `winget install Python.Python.3.12`) with the py launcher. The Microsoft Store stub does not count."
    : process.platform === "darwin"
      ? "macOS: `brew install python` (or https://www.python.org/downloads/)."
      : "Linux: `sudo apt install python3` (Debian/Ubuntu) or `sudo dnf install python3` (Fedora).";
  throw new Fatal(`No Python >= 3.9 found (tried: ${rejected.join("; ") || "nothing"}).\n${how}\nOr set python.path in foreman.json / PI_FOREMAN_PYTHON, then re-run.`);
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

function entrySource(e) {
  if (typeof e === "string") return e;
  if (isObj(e) && typeof e.source === "string") return e.source;
  return null;
}

/** Is `spec` (an exact npm pin, or the local checkout path) recorded in settings.packages? */
function isRecorded(settings, spec, baseDir) {
  const list = settings && Array.isArray(settings.packages) ? settings.packages : [];
  const norm = (p) => (WIN ? p.toLowerCase() : p);
  for (const e of list) {
    const src = entrySource(e);
    if (!src) continue;
    if (spec.startsWith("npm:")) {
      if (src === spec) return true;
      continue;
    }
    if (/^(npm|git|https?|ssh):/.test(src) || src.startsWith("git@")) continue;
    let resolved = path.resolve(baseDir, src);
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      /* dangling entry: compare unresolved */
    }
    if (norm(resolved) === norm(spec)) return true;
  }
  return false;
}

const isBridgeEntry = (e) => /(^|[/:@])pi-claude-bridge(@|$|\/)/.test(entrySource(e) ?? "");
const isForemanEntry = (e, baseDir) => {
  const src = entrySource(e);
  if (!src) return false;
  if (/^npm:pi-foreman(@|$)/.test(src)) return true;
  return isRecorded({ packages: [e] }, ROOT, baseDir);
};

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

function main(argv) {
  const opts = parseArgs(argv);
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

  return opts.remove ? removeAll() : install();

  // ------------------------------------------------------------ remove
  function removeAll() {
    const cmds = [];
    if (isRecorded(settings, ROOT, baseDir)) cmds.push(["remove", ROOT, ...(opts.project ? ["-l"] : [])]);
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
      say(unifiedDiff(path.basename(settingsFile), settingsText, toJson(next)));
    } else say("subagents block: not ours or edited by hand, kept");
    const permText = readText(permFile);
    const permRecorded = isObj(managed.files) ? managed.files[permFile] : undefined;
    let dropPerm = false;
    if (permText === null) say("permission-system config: none present");
    else if (permRecorded && permRecorded === (() => { try { return sha(parseJsonObject(permText, permFile)); } catch { return null; } })()) {
      dropPerm = true;
      say(`permission-system config: unchanged since written, removing ${permFile}`);
    } else say("permission-system config: not ours or edited by hand, kept");
    for (const c of cmds) say(`${dry ? "would run" : "will run"}: pi ${c.join(" ")}`);
    if (!cmds.length && !next && !dropPerm) {
      say("pi-foreman: up to date, nothing to remove.");
      return;
    }
    say("kept: foreman.json, backups, pi-subagents, pi-intercom and its config, and any overlay (use `pi remove <source>` for those).");
    if (dry) return;
    backup();
    for (const c of cmds) runOrDie(c);
    if (next) {
      const fresh = parseJsonObject(readText(settingsFile), settingsFile) ?? {};
      dropManaged(fresh);
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
  }

  // ------------------------------------------------------------ install
  function install() {
    const py = resolvePython(agentDir);
    say(`  python ${py.version.join(".")} via ${py.source}: ${py.executable}`);
    let anyChange = false;

    // config template first, so the generator and validator see it
    const template = toJson({ version: 1, providers: {} });
    if (readText(foremanFile) === null) {
      anyChange = true;
      say(`foreman.json: absent, ${dry ? "would create" : "creating"} a template`);
      if (dry) say(unifiedDiff("foreman.json", null, template));
      else writeFile(foremanFile, template);
    } else say("foreman.json: present, left alone");

    // packages
    const want = [];
    for (const p of lock.packages) {
      if (p.name === INTERCOM && opts.noIntercom) say(`  package ${p.name}@${p.version}: skipped (--no-intercom)`);
      else if (p.mode === "install") want.push({ spec: `npm:${p.name}@${p.version}`, label: `${p.name}@${p.version}` });
      else if (p.mode === "local") want.push({ spec: ROOT, label: `${p.name} (local checkout ${ROOT})` });
      else if (p.mode === "phase3") say(`  pinned, installed from Phase 3: ${p.name}@${p.version}`);
    }
    if (opts.overlay) want.push({ spec: opts.overlay, label: `overlay ${opts.overlay}` });
    const todo = want.filter((w) => !isRecorded(settings, w.spec, baseDir));
    for (const w of want) say(`  package ${w.label}: ${todo.includes(w) ? "to install" : "already recorded"}`);
    const installArgs = todo.map((w) => ["install", w.spec, ...(opts.project ? ["-l"] : [])]);
    if (installArgs.length) anyChange = true;
    // load order: pi-foreman before pi-claude-bridge (after `pi install` appended what was missing)
    const plannedPackages = [...(Array.isArray(settings.packages) ? settings.packages : []), ...todo.map((w) => (w.spec === ROOT ? path.relative(baseDir, ROOT) : w.spec))];
    const reordered = foremanBeforeBridge(plannedPackages, baseDir);
    if (reordered) {
      anyChange = true;
      say(`packages: ${dry ? "would move" : "moving"} pi-foreman before pi-claude-bridge, so its config-drift check runs before the bridge's compaction and branch summaries`);
      say(unifiedDiff(path.basename(settingsFile), toJson({ ...settings, packages: plannedPackages }), toJson({ ...settings, packages: reordered })));
    }
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
    let next = settings;
    if (!same) {
      anyChange = true;
      next = structuredClone(settings);
      applyWanted(next);
      if (hasCur && record && sha(cur) !== record.subagentsHash) say("subagents block: edited by hand since the last install; backing it up and overwriting");
      else if (hasCur && !record) say("subagents block: present but not recorded as ours; backing it up and overwriting");
      else say("subagents block: writing the generated block");
      say(unifiedDiff(path.basename(settingsFile), settingsText, toJson(next)));
      if (installArgs.length) say("  (the diff leaves out `packages`, which `pi install` edits itself)");
    } else say("subagents block: in sync");
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

    if (dry) {
      for (const a of installArgs) say(`would run: pi ${a.join(" ")}`);
      if (needRecord || permNeedRecord) say(`would record the managed hash in ${managedFile}`);
    } else if (anyChange) {
      if (installArgs.length || !same || reordered) backup();
      for (const a of installArgs) runOrDie(a);
      let finalBlock = pick(next.subagents);
      if (!same || reordered) {
        // pi edits `packages` in the same file, so merge into what is on disk now
        const fresh = parseJsonObject(readText(settingsFile), settingsFile) ?? {};
        if (!same) applyWanted(fresh);
        const order = foremanBeforeBridge(fresh.packages, baseDir);
        if (order) fresh.packages = order;
        writeFile(settingsFile, toJson(fresh));
        if (!same) finalBlock = pick(fresh.subagents);
      }
      managed.entries[settingsFile] = { subagentsHash: sha(finalBlock) };
      if (!permSame) {
        if (permText !== null) {
          const file = `${permFile}.bak-${timestamp()}`;
          fs.copyFileSync(permFile, file);
          say(`  backup: ${file}`);
        }
        writeFile(permFile, toJson(permWanted));
      }
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

    if (!anyChange) say("pi-foreman: up to date, nothing to change.");
    else if (dry) say("pi-foreman: dry run complete, nothing written.");
    else say("pi-foreman: done. Run /foreman doctor inside pi to check the setup.");
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof Fatal) {
    (err.code === 0 ? console.log : console.error)(err.message);
    process.exitCode = err.code;
  } else {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
}
