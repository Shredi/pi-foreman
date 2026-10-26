#!/usr/bin/env node
// `foreman features list|addons|profile|enable|disable` (docs/install.md, "Profiles, features and add-ons"). Plain Node >= 22 ESM.
//   list [--json] [--agent-dir <dir>]   every feature: id, area, state, the recorded profile's expectation, `*` on a deviation
//   addons [--json] [--agent-dir <dir>] the add-on registry with its installed state from the global and the project settings file
//   profile <name> | enable <id>... | disable <id>...   [--dry-run] [--project] [--agent-dir <dir>]
//     run `node setup.mjs` with the matching flags: one write path, so these run the whole setup (Pi on PATH, a possible
//     `npm ci` in a checkout), not just the foreman.json step.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assignment, deviations, featureState, installedAddons, loadAddons, loadDefaults, loadFeatures, loadProfiles, resolveSetupPython } from "../extensions/core-adapter/profiles.mjs";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const USAGE = [
  "Usage: foreman features list [--json] [--agent-dir <dir>]",
  "       foreman features addons [--json] [--agent-dir <dir>]",
  "       foreman features profile <name> [--dry-run] [--project] [--agent-dir <dir>]",
  "       foreman features enable <id>... [--dry-run] [--project] [--agent-dir <dir>]",
  "       foreman features disable <id>... [--dry-run] [--project] [--agent-dir <dir>]",
  "  profile, enable and disable run the whole `foreman setup` with --profile, --enable or --disable.",
].join("\n");

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

function parse(argv) {
  const o = { sub: argv[0], json: false, dryRun: false, project: false, agentDir: null, rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--project") o.project = true;
    else if (a === "--agent-dir") o.agentDir = argv[++i] ?? fail(`--agent-dir needs a value.\n${USAGE}`);
    else if (a.startsWith("--agent-dir=")) o.agentDir = a.slice("--agent-dir=".length);
    else if (a.startsWith("--")) fail(`Unknown argument: ${a}\n${USAGE}`);
    else o.rest.push(a);
  }
  return o;
}

function agentDirOf(arg) {
  let d = arg || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) d = path.join(os.homedir(), d.slice(1));
  return path.resolve(d);
}

function packagesOf(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(s?.packages) ? s.packages : [];
  } catch {
    return [];
  }
}

/** The user-plus-overlay merged config (no project or session layer). */
function mergedConfig(agentDir) {
  let py;
  try {
    py = resolveSetupPython(agentDir);
  } catch (err) {
    fail(err.message, 1);
  }
  const r = spawnSync(py.executable, ["-E", "-s", path.join(ROOT, "scripts", "foreman_config.py"), "merged", "--json", "--agent-dir", agentDir], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    /* reported below */
  }
  if (!data || typeof data.config !== "object") fail(`foreman_config.py merged failed (exit ${r.status}): ${(r.stderr || "").trim() || "no JSON output"}`, 1);
  return data.config;
}

function list(o) {
  const agentDir = agentDirOf(o.agentDir);
  const config = mergedConfig(agentDir);
  const features = loadFeatures();
  const defaults = loadDefaults();
  const recorded = typeof config.profile === "string" && config.profile ? config.profile : null;
  const known = recorded !== null && Object.hasOwn(loadProfiles().profiles, recorded);
  const dev = new Map(deviations(config, known ? recorded : null).map((d) => [d.id, d]));
  const expected = known ? assignment(recorded) : {};
  const rows = features.features.map((f) => ({
    id: f.id, area: f.area, state: featureState(f, config, defaults), profile: expected[f.id] ?? null, deviates: dev.has(f.id), toggle: f.toggle !== undefined,
  }));
  if (o.json) {
    console.log(JSON.stringify({ profile: recorded, known, features: rows.map(({ id, area, state, profile, deviates, toggle }) => ({ id, area, state, profile, deviates, toggle })) }, null, 2));
    return;
  }
  console.log(`profile: ${recorded ?? "none (run foreman setup --pick or --profile <name>)"}${recorded && !known ? " (unknown)" : ""}`);
  const width = (k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "-").length));
  const [wi, wa, ws] = [width("id"), width("area"), width("state")];
  console.log(`  ${"id".padEnd(wi)}  ${"area".padEnd(wa)}  ${"state".padEnd(ws)}  profile`);
  for (const r of rows) console.log(`  ${r.id.padEnd(wi)}  ${r.area.padEnd(wa)}  ${r.state.padEnd(ws)}  ${r.profile ?? "-"}${r.deviates ? " *" : ""}`);
  console.log("* = differs from the recorded profile; toggle with `foreman features enable|disable <id>`. Features with no profile column are not toggleable.");
}

function addons(o) {
  const agentDir = agentDirOf(o.agentDir);
  const installed = installedAddons(packagesOf(path.join(agentDir, "settings.json")), packagesOf(path.join(process.cwd(), ".pi", "settings.json")));
  const rows = loadAddons().addons.map((a) => ({
    id: a.id,
    spec: `npm:${a.package}@${a.version}`,
    installed: installed.filter((i) => i.id === a.id).map((i) => ({ source: i.source, scope: i.scope })),
    purpose: a.purpose,
  }));
  if (o.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of rows) {
    const state = r.installed.length ? `installed (${r.installed.map((i) => `${i.source}, ${i.scope}`).join("; ")})` : `not installed; install with: foreman setup --addon ${r.id}`;
    console.log(`${r.id}  ${r.spec}  ${state}`);
    console.log(`  ${r.purpose}`);
  }
}

function viaSetup(o) {
  if (!o.rest.length) fail(`${o.sub} needs ${o.sub === "profile" ? "a profile name" : "at least one feature id"}.\n${USAGE}`);
  if (o.sub === "profile" && o.rest.length !== 1) fail(`profile takes exactly one name.\n${USAGE}`);
  const flags = o.sub === "profile" ? ["--profile", o.rest[0]] : o.rest.flatMap((id) => [`--${o.sub}`, id]);
  if (o.dryRun) flags.push("--dry-run");
  if (o.project) flags.push("--project");
  if (o.agentDir) flags.push("--agent-dir", o.agentDir);
  const r = spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), ...flags], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const o = parse(process.argv.slice(2));
if (o.sub === "list") list(o);
else if (o.sub === "addons") addons(o);
else if (o.sub === "profile" || o.sub === "enable" || o.sub === "disable") viaSetup(o);
else fail(USAGE);
