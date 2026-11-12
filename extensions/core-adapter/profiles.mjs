// Feature profiles, toggles and add-ons: the shared logic of setup.mjs, scripts/foreman_features.mjs and the doctor.
// Plain JS so the installer (no TS toolchain) and the adapter import the same code. No TS syntax here.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const WIN = process.platform === "win32";
const MIN_PY = [3, 13];
const PROBE_CODE = "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable)";
const DOC = "docs/features.md";

/** Leaf patterns no toggle may write (`*` is one path segment; a trailing `.*` is the subtree). */
export const SAFETY_FLOOR = [
  "safety.permissions.*", "safety.git.*", "safety.ops.*", "safety.requiredChildExtensions", "safety.preconditionOps",
  "ceremony.foremanEdits", "ceremony.required", "ceremony.reviewBeforePr", "ceremony.reviewGate", "ceremony.requireTriage",
  "bridge.*", "python.*", "presence.command", "sidebar.statusCommand", "tools.prHost", "roles.*.mcp", "roles.*.file", "paths.hubWorkflow",
];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Stable stringify (sorted keys), for value equality. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const same = (a, b) => canonical(a) === canonical(b);

// ---------------------------------------------------------------- loaders

const readJson = (root, ...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"));
/** `config/features.json` as parsed ({ features: [...] , ... }). */
export const loadFeatures = (root = ROOT) => readJson(root, "config", "features.json");
/** `config/profiles.json` as parsed ({ profiles: { name: { title, summary, features } } }). */
export const loadProfiles = (root = ROOT) => readJson(root, "config", "profiles.json");
/** `config/addons.json` as parsed ({ addons: [...] }). */
export const loadAddons = (root = ROOT) => readJson(root, "config", "addons.json");
/** `config/foreman.defaults.json` as parsed. */
export const loadDefaults = (root = ROOT) => readJson(root, "config", "foreman.defaults.json");

const featureList = (features) => (Array.isArray(features) ? features : (features?.features ?? []));
const profileMap = (profiles) => profiles?.profiles ?? profiles ?? {};

// ---------------------------------------------------------------- paths

/** The value at a dotted path: { present, value }. */
function getAt(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split(".")) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return { present: false, value: undefined };
    cur = cur[k];
  }
  return { present: true, value: cur };
}

function setAt(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

const providersOf = (config) => (isObj(config?.providers) ? Object.keys(config.providers) : []);

/** A toggle patch as leaves; `providers.*` is expanded over `providers` (names), or yields nothing when none is present. */
function leavesOf(patch, providers) {
  const out = [];
  for (const [p, value] of Object.entries(patch)) {
    if (p.startsWith("providers.*.")) for (const name of providers) out.push({ path: `providers.${name}.${p.slice("providers.*.".length)}`, value });
    else out.push({ path: p, value });
  }
  return out;
}
const hasWildcard = (patch) => Object.keys(patch).some((p) => p.includes("*"));

// ---------------------------------------------------------------- features

/** Features that carry a `toggle`. */
export const toggleable = (features) => featureList(features).filter((f) => isObj(f.toggle));

/** "on" or "off": the side of the toggle that equals the shipped default (or the declared `toggle.shipped`); null when neither does. */
export function shippedState(feature, defaults) {
  const t = feature.toggle;
  if (!isObj(t)) return null;
  if (t.shipped === "on" || t.shipped === "off") return t.shipped;
  for (const [p, on] of Object.entries(t.on ?? {})) {
    if (p.includes("*")) continue;
    const d = getAt(defaults, p);
    if (!d.present) continue;
    if (same(d.value, on)) return "on";
    if (same(d.value, t.off?.[p])) return "off";
    return null;
  }
  return null;
}

const segment = (s) => (s === "*" ? "[^.]+" : s.replace(/[.+^$(){}|[\]\\]/g, "\\$&"));
const floorRegex = (pattern) => {
  const parts = pattern.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "*") return new RegExp(`^${parts.slice(0, -1).map(segment).join("\\.")}(\\..+)?$`);
  return new RegExp(`^${parts.map(segment).join("\\.")}$`);
};

/** Toggle leaves that fall into the safety floor: [{ id, leaf }]. */
export function safetyFloorViolations(features) {
  const regexes = SAFETY_FLOOR.map(floorRegex);
  const out = [];
  for (const f of toggleable(features)) {
    for (const side of ["on", "off"]) {
      for (const leaf of Object.keys(f.toggle[side] ?? {})) if (regexes.some((r) => r.test(leaf))) out.push({ id: f.id, leaf });
    }
  }
  return out;
}

/**
 * The full feature-to-state map of a profile ("on"/"off" per toggleable id): the named features as given, every other one in its
 * shipped state. null for an unknown profile name.
 */
export function assignment(profileName, root = ROOT) {
  const profiles = profileMap(loadProfiles(root));
  if (typeof profileName !== "string" || !Object.hasOwn(profiles, profileName)) return null;
  const features = loadFeatures(root);
  const defaults = loadDefaults(root);
  const named = profiles[profileName].features ?? {};
  const out = {};
  for (const f of toggleable(features)) {
    out[f.id] = Object.hasOwn(named, f.id) ? (named[f.id] ? "on" : "off") : (shippedState(f, defaults) ?? "off");
  }
  return out;
}

const idsText = (list) => list.map((f) => f.id).join(", ");

/**
 * Applies a profile, then `enable`, then `disable` to the user config.
 * Returns { config, changes: [{ feature, state, leaves: [{ path, value }], notes: [string] }], relaxations: [id], errors: [string] }.
 * `config` is a copy (the input is not modified) and also carries `profile` when one is given. A leaf is written only when it
 * differs from the file (an absent leaf counts as the shipped state). Errors leave `config` equal to the input.
 */
export function planChanges(userConfig, { profile, enable = [], disable = [] } = {}, root = ROOT) {
  const features = loadFeatures(root);
  const defaults = loadDefaults(root);
  const toggles = toggleable(features);
  const byId = new Map(featureList(features).map((f) => [f.id, f]));
  const errors = [];
  const states = new Map();
  const named = new Set();
  if (profile !== undefined && profile !== null) {
    const a = assignment(profile, root);
    if (!a) errors.push(`unknown profile ${profile}; valid: ${Object.keys(profileMap(loadProfiles(root))).join(", ")}`);
    else {
      for (const [id, st] of Object.entries(a)) states.set(id, st);
      for (const id of Object.keys(profileMap(loadProfiles(root))[profile].features ?? {})) named.add(id);
    }
  }
  const check = (id) => {
    const f = byId.get(id);
    if (!f) errors.push(`unknown feature id ${id}; toggleable: ${idsText(toggles)}`);
    else if (!isObj(f.toggle)) errors.push(`${id} is not toggleable (see ${DOC}); set it by hand in foreman.json${f.enable ? `: ${f.enable}` : ""}`);
    else return true;
    return false;
  };
  for (const id of enable) if (disable.includes(id)) errors.push(`${id} is in both enable and disable`);
  for (const id of enable) {
    if (!check(id)) continue;
    states.set(id, "on");
    named.add(id);
  }
  for (const id of disable) {
    if (!check(id) || enable.includes(id)) continue;
    states.set(id, "off");
    named.add(id);
  }

  const input = isObj(userConfig) ? userConfig : {};
  if (errors.length) return { config: input, changes: [], relaxations: [], errors };
  const next = structuredClone(input);
  const providers = providersOf(input);
  const changes = [];
  const relaxations = [];
  for (const f of toggles) {
    const st = states.get(f.id);
    if (!st) continue;
    const ship = shippedState(f, defaults);
    const patch = f.toggle[st] ?? {};
    const leaves = [];
    const notes = [];
    for (const leaf of leavesOf(patch, providers)) {
      const cur = getAt(next, leaf.path);
      if (cur.present ? same(cur.value, leaf.value) : st === ship) continue;
      setAt(next, leaf.path, leaf.value);
      leaves.push(leaf);
    }
    if (hasWildcard(patch) && providers.length === 0 && (named.has(f.id) || st !== ship)) notes.push("no provider present, nothing written");
    if (leaves.length || notes.length) changes.push({ feature: f.id, state: st, leaves, notes });
    if (st === "on" && f.toggle.relaxes) relaxations.push(f.id);
  }
  if (profile !== undefined && profile !== null) {
    if ("profile" in next) next.profile = profile;
    else {
      // New key goes right after `version`, so the file keeps a stable shape.
      const entries = Object.entries(next);
      const at = entries.findIndex(([k]) => k === "version") + 1;
      entries.splice(at, 0, ["profile", profile]);
      for (const k of Object.keys(next)) delete next[k];
      for (const [k, v] of entries) next[k] = v;
    }
  }
  return { config: next, changes, relaxations, errors };
}

/**
 * Rows where the config differs from the profile: [{ id, expected, actual }] ("on"/"off"/"other"). Pass the config merged
 * without the project and session layers. An absent leaf equals the shipped state; a provider absent from the config gives no
 * row for a `providers.*` toggle; an unknown or missing profile gives an empty list.
 */
export function deviations(config, profileName, root = ROOT) {
  const a = assignment(profileName, root);
  if (!a) return [];
  const features = loadFeatures(root);
  const defaults = loadDefaults(root);
  const providers = providersOf(config);
  const rows = [];
  for (const f of toggleable(features)) {
    const expected = a[f.id];
    const ship = shippedState(f, defaults);
    for (const leaf of leavesOf(f.toggle[expected] ?? {}, providers)) {
      const cur = getAt(config, leaf.path);
      if (cur.present ? same(cur.value, leaf.value) : expected === ship) continue;
      let actual = "other";
      if (!cur.present) actual = ship;
      else if (same(cur.value, f.toggle.on?.[leafKey(f, leaf.path)])) actual = "on";
      else if (same(cur.value, f.toggle.off?.[leafKey(f, leaf.path)])) actual = "off";
      rows.push({ id: f.id, expected, actual });
      break;
    }
  }
  return rows;
}

/** Values at a dotted path whose segments may be `*` (every key of an object at that level). */
function collect(obj, segments) {
  if (!segments.length) return [obj];
  if (!isObj(obj)) return [];
  const [head, ...rest] = segments;
  if (head === "*") return Object.values(obj).flatMap((v) => collect(v, rest));
  return Object.hasOwn(obj, head) ? collect(obj[head], rest) : [];
}

const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : typeof v === "string" ? v !== "" : false);

/**
 * The state of a feature in a config, for listings: "on", "off", "auto" (a toggle whose on side is null, so left to the
 * runtime), "configured" (a toggle whose leaves hold other values or disagree) or "n/a" (no toggle and no switch, or a
 * `providers.*` toggle with no provider present). A toggle's absent leaf counts as the shipped state.
 */
export function featureState(feature, config, defaults) {
  if (isObj(feature.toggle)) {
    const ship = shippedState(feature, defaults);
    const seen = new Set();
    for (const leaf of leavesOf(feature.toggle.on ?? {}, providersOf(config))) {
      const cur = getAt(config, leaf.path);
      const key = leafKey(feature, leaf.path);
      if (!cur.present) seen.add(ship);
      else if (same(cur.value, feature.toggle.on[key])) seen.add("on");
      else if (same(cur.value, feature.toggle.off?.[key])) seen.add("off");
      else seen.add("configured");
    }
    if (seen.size === 0) return "n/a";
    if (seen.size > 1) return "configured";
    const [only] = seen;
    return only === "on" && Object.values(feature.toggle.on).some((v) => v === null) ? "auto" : only;
  }
  const sw = feature.switch;
  if (!isObj(sw) || typeof sw.key !== "string") return "n/a";
  const values = collect(config, sw.key.split("."));
  const on = sw.on === "true" ? values.some((v) => v === true) : sw.on === "nonnull" ? values.some((v) => v !== null && v !== undefined) : values.some(nonEmpty);
  return on ? "on" : "off";
}

/** The patch key (possibly `providers.*...`) a concrete leaf path came from. */
function leafKey(feature, concrete) {
  for (const p of Object.keys(feature.toggle.on ?? {})) {
    if (p === concrete) return p;
    if (p.startsWith("providers.*.") && concrete.startsWith("providers.") && concrete.endsWith(p.slice("providers.*".length))) return p;
  }
  return concrete;
}

// ---------------------------------------------------------------- add-ons

const escapeRe = (s) => s.replace(/[.+^$(){}|[\]\\*?]/g, "\\$&");
const sourceOf = (e) => (typeof e === "string" ? e : isObj(e) && typeof e.source === "string" ? e.source : null);

/**
 * Registry add-ons found in the package lists of the global and the project settings file (`npm:<pkg>` or `npm:<pkg>@<ver>`):
 * [{ id, source, scope: "global" | "project" }], one per add-on and file.
 */
export function installedAddons(globalPackages, projectPackages, root = ROOT) {
  const out = [];
  for (const addon of loadAddons(root).addons ?? []) {
    const re = new RegExp(`^npm:${escapeRe(addon.package)}(@[^/]*)?$`);
    for (const [scope, list] of [["global", globalPackages], ["project", projectPackages]]) {
      for (const e of Array.isArray(list) ? list : []) {
        const src = sourceOf(e);
        if (src && re.test(src)) {
          out.push({ id: addon.id, source: src, scope });
          break;
        }
      }
    }
  }
  return out;
}

/** The flag line that repeats a choice: { profile?, enable?, disable?, addons?, project? } -> `foreman setup --profile ...`. */
export function equivalentCommand({ profile, enable = [], disable = [], addons = [], project = false } = {}) {
  const parts = ["foreman setup"];
  if (project) parts.push("--project");
  if (profile) parts.push(`--profile ${profile}`);
  if (enable.length) parts.push(`--enable ${enable.join(",")}`);
  if (disable.length) parts.push(`--disable ${disable.join(",")}`);
  for (const id of addons) parts.push(`--addon ${id}`);
  return parts.join(" ");
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

/** The Python >= 3.13 setup and the features CLI run scripts with: { executable, version: [major, minor], source }. Throws an Error with the how-to text when none is found. */
export function resolveSetupPython(agentDir) {
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
      rejected.push(`${label}: Python ${ver.join(".")} is older than 3.13`);
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
    ? "Windows: `winget install Python.Python.3.13` (or https://www.python.org/downloads/) with the py launcher. The Microsoft Store stub does not count."
    : process.platform === "darwin"
      ? "macOS: the Command Line Tools python3 is 3.9. Install 3.13 with `brew install python@3.13` (or https://www.python.org/downloads/)."
      : "Linux: a python3.13 package from your distro (Debian/Ubuntu: the deadsnakes PPA), or `uv python install 3.13`.";
  throw new Error(`No Python >= 3.13 found (tried: ${rejected.join("; ") || "nothing"}).\n${how}\nOr set python.path in foreman.json / PI_FOREMAN_PYTHON, then re-run.`);
}

// The Herdr app mods the package ships (integrations/herdr-app/<mod>/) and the copies installed under the app home's mods/ folder: `foreman setup --mods`, the setup offer and the /foreman doctor warning.
export const MODS = ["pi-foreman", "pi-foreman-plan"];
// Never copied: the test files, the .gitignore, and the two files `herdr-app check` writes into the app's mod folder.
const SKIPPED_NAMES = new Set([".gitignore", "gpui-kit.d.ts", "jsconfig.json"]);
const SKIPPED_TOP = new Set(["cache"]); // app-written state (the plan mod's rendered SVG cache)
const FILE_CAP = 5;

/** The app home: HERDR_APP_HOME when set, else `<home>/.config/herdr-app` on every OS (the app's documented default). */
export function appHome(env = process.env, home = os.homedir()) {
  return env.HERDR_APP_HOME || path.join(home, ".config", "herdr-app");
}

/** The app home the in-process `/foreman doctor` reads: HERDR_APP_HOME, else the test preload's seed (`Symbol.for("pi-foreman.herdr-app-home")`), else the default. */
export function doctorAppHome(env = process.env, home = os.homedir()) {
  return appHome({ HERDR_APP_HOME: env.HERDR_APP_HOME || globalThis[Symbol.for("pi-foreman.herdr-app-home")]?.seed }, home);
}

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();

/** The package's source files of one mod: regular files, recursive, relative paths with forward slashes, sorted. */
export function sourceFiles(modDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!rel && SKIPPED_TOP.has(ent.name)) continue;
        walk(path.join(dir, ent.name), r);
      } else if (ent.isFile() && !SKIPPED_NAMES.has(ent.name) && !ent.name.endsWith(".test.mjs")) out.push(r);
    }
  };
  walk(modDir, "");
  return out.sort();
}

const pkgModDir = (packageRoot, mod) => path.join(packageRoot, "integrations", "herdr-app", mod);
const installedModDir = (home, mod) => path.join(home, "mods", mod);
const fromRel = (base, rel) => path.join(base, ...rel.split("/"));

/** Source files missing from the installed copy, differing from it by bytes, or with a folder in their place. Only installed mods are compared. */
export function diffMods({ packageRoot, appHome: home }) {
  const out = [];
  for (const mod of MODS) {
    const installed = installedModDir(home, mod);
    const src = pkgModDir(packageRoot, mod);
    if (!isDir(installed) || !isDir(src)) continue;
    const files = sourceFiles(src).filter((rel) => {
      const have = fromRel(installed, rel);
      return !fs.existsSync(have) || isDir(have) || Buffer.compare(fs.readFileSync(fromRel(src, rel)), fs.readFileSync(have)) !== 0;
    });
    if (files.length) out.push({ mod, files });
  }
  return out;
}

/** True when a refresh cannot write `rel` below `base`: a folder sits where the file belongs, or a file sits where one of its sub-folders belongs. */
function inTheWay(base, rel) {
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = path.join(base, ...parts.slice(0, i));
    if (fs.existsSync(dir) && !isDir(dir)) return true;
  }
  return isDir(fromRel(base, rel));
}

/** Splits a diff list into the entries a refresh writes and the entries it leaves alone because something else is in their place (`blocked`). */
export function splitBlockedMods(home, changed) {
  const writable = [];
  const blocked = [];
  for (const { mod, files } of changed) {
    const base = installedModDir(home, mod);
    const stuck = files.filter((rel) => inTheWay(base, rel));
    if (stuck.length) blocked.push({ mod, files: stuck });
    const rest = files.filter((rel) => !stuck.includes(rel));
    if (rest.length) writable.push({ mod, files: rest });
  }
  return { writable, blocked };
}

/** Copies exactly the differing files into the installed mods (creating sub-folders); deletes nothing, installs no mod; a file or folder in the way of a copy is left as it is (the diff keeps reporting it; `splitBlockedMods` names it). `dryRun` writes nothing and returns the same list. */
export function refreshMods({ packageRoot, appHome: home, dryRun = false }) {
  const changed = diffMods({ packageRoot, appHome: home });
  if (dryRun) return changed;
  for (const { mod, files } of changed) {
    for (const rel of files) {
      const to = fromRel(installedModDir(home, mod), rel);
      if (inTheWay(installedModDir(home, mod), rel)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(fromRel(pkgModDir(packageRoot, mod), rel), to);
    }
  }
  return changed;
}

/** The file list as shown to the owner: the first few, then `+N more`. */
export function fileList(files) {
  return files.length > FILE_CAP ? `${files.slice(0, FILE_CAP).join(", ")}, +${files.length - FILE_CAP} more` : files.join(", ");
}

/** One WARN line per installed mod that differs from the package; none when every installed mod is in step, or none is installed. */
export function modsDoctorLines(opts) {
  return diffMods(opts).map(({ mod, files }) => `WARN herdr-app mod ${mod} differs from the package: ${fileList(files)} — fix: foreman setup --mods`);
}
