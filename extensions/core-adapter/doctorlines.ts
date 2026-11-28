// The file, config and environment checks of the doctor, as plain functions of plain data. `/foreman doctor` (index.ts) calls them at their
// place in its output and keeps the registry, login and live-session checks inline; `foreman doctor` (doctor-cli.ts) calls the same
// functions without a running Pi. No import of Pi packages, index.ts or scriptrun.ts: the shell form must load from a package install.
import * as fs from "node:fs";
import * as path from "node:path";
import { canonical, generateSubagents, get, loadMergedConfig } from "./config.ts";
import type { Json, MergedConfig } from "./config.ts";
import { NO_PYTHON_FIX } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import type { Spawner } from "./spawn.ts";
import { missingBundled, noticeChannelsDoctor, worktreeDoctor } from "./registry.ts";
import { worktreeRootDoctor } from "./worktreeroot.ts";
import { piModelDataDir } from "./pi-model-data.mjs";
import { PRESSURE_FIXTURE_ENV, limitsOf, pressureDoctorLine, pressurePath, readPressure, sampleSecondsOf } from "./pressure.ts";
import { bridgeLoadOrder, PROJECT_BRIDGE_FIX, projectBridgeConfigRisks, userBridgeConfigRisks } from "./bridgeiso.ts";
import { bridgeTrusted } from "./bridgetrust.ts";
import { intercomDoctor } from "./intercomguard.ts";
import { gateLogFile } from "./gatelog.ts";
import { ALLOW_WARN_ENTRIES } from "./permconfig.ts";
import type { PermStore } from "./permconfig.ts";
import { hubWorkflowDriftLines } from "./hubdrift.ts";
import { gateMigrationLines } from "./gatemigrate.ts";
import { doctorAppHome, modsDoctorLines } from "./profiles.mjs";
import { SHADOW_FIX, shadowedRoles } from "./agentscope.ts";
import { childRoleIds } from "./roles.ts";
import { resolveGithubHosts } from "./prhost.ts";
import { lastPollAgeMs, trackerDoctorLine } from "./prstore.ts";
import { openPrsConfig } from "./openprs.ts";
import { addonPeerRangeLine, addonPresent, bgFeaturesDoctor, optionalAddonsDoctor } from "./bg.ts";
import { profileDoctorLines } from "./profiledoctor.ts";
import type { ChildExtension } from "./childext.ts";

export const okLine = (m: string): string => `OK   ${m}`;
export const failLine = (m: string, fix: string): string => `FAIL ${m} — fix: ${fix}`;

/** Python, the core scripts, the bundled packages, the worktree and notice-channel settings and the worktree root. */
export function installLines(i: { python: PythonResolution; coreDir: string; pkgRoot: string; agentDir: string; cwd: string; platform: string; config: unknown; roots: { installRoot: string | null; npmRoot: string | null } }): string[] {
  const out: string[] = [];
  if (i.python.ok) out.push(okLine(`Python ${i.python.info.version.join(".")} at ${i.python.info.executable} (${i.python.info.source})`));
  else out.push(failLine(`no Python ≥ 3.13 (tried: ${i.python.rejected.join("; ") || "nothing"})`, NO_PYTHON_FIX.replace(/; run \/foreman doctor\.$/, ".")));
  for (const r of i.python.rejected) if (r.includes("inside the workspace")) out.push(`INFO Python candidate ${r}: the guards never run on an interpreter or venv a child can write; use one outside the project (python.path in your user foreman.json or PI_FOREMAN_PYTHON).`);

  if (fs.existsSync(path.join(i.coreDir, "scripts", "ledger_guard_write.py"))) out.push(okLine(`core scripts at ${i.coreDir}`));
  else out.push(failLine(`core scripts missing under ${i.coreDir}`, "reinstall pi-foreman (core/ ships with the package)."));
  const unbundled = missingBundled(i.pkgRoot);
  if (unbundled.length) out.push(failLine(`bundled packages missing under ${path.join(i.pkgRoot, "node_modules")}: ${unbundled.join(", ")}`, "run pi update --extensions (or npm ci in a checkout), then restart."));
  else out.push(okLine(`bundled packages present under ${path.join(i.pkgRoot, "node_modules")}`));
  out.push(...worktreeDoctor(i.agentDir, i.cwd, i.platform, i.pkgRoot));
  out.push(...noticeChannelsDoctor(i.agentDir));
  out.push(...worktreeRootDoctor(i.config, i.cwd, i.platform, { installRoot: i.roots.installRoot, npmRoot: i.roots.npmRoot }));
  return out;
}

/** Where the merged config came from and whether it loaded clean. */
export function configLines(c: MergedConfig): string[] {
  if (c.source === "defaults") return [failLine("config CLI did not run; L1 defaults in use", "fix Python first, then check scripts/foreman_config.py.")];
  if (c.errors.length) return [failLine(`config errors: ${c.errors.join("; ")}`, "correct the named keys in your foreman.json.")];
  return [okLine(`config loaded (${c.warnings.length} warning(s)${c.warnings.length ? ": " + c.warnings.join("; ") : ""})`)];
}

/** The generated subagents block against settings.json; `settings` is the parsed file (null when unreadable), which later checks reuse. */
export async function subagentsLines(i: { python: string | null; pkgRoot: string; agentDir: string; cwd: string; trusted: boolean; spawner: Spawner }): Promise<{ lines: string[]; settings: Record<string, unknown> | null }> {
  const generated = await generateSubagents({ python: i.python, pkgRoot: i.pkgRoot, agentDir: i.agentDir, projectDir: i.cwd, trusted: i.trusted, spawner: i.spawner });
  let settings: Record<string, unknown> | null = null;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(i.agentDir, "settings.json"), "utf8"));
  } catch {
    settings = null;
  }
  if (!generated) return { lines: [failLine("could not generate the subagents block", "fix Python/config first.")], settings };
  const have = (settings?.subagents ?? {}) as Record<string, unknown>;
  const keys = ["agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"];
  const same = keys.every((k) => canonical(have[k] ?? null) === canonical((generated as Record<string, unknown>)[k] ?? null));
  if (same) return { lines: [okLine("generated subagents block in settings.json is in sync")], settings };
  return { lines: [failLine("subagents block in settings.json differs from generate-subagents", "run /foreman setup or the installer to regenerate it.")], settings };
}

/** The compaction overrides setup wrote (managed.json) against their settings files, and the Pi model data note. */
export function compactionLines(agentDir: string): string[] {
  const out: string[] = [];
  // compaction overrides setup wrote: for every settings file with a record, the recorded value must still be the one in the file
  try {
    const managed = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-foreman", "managed.json"), "utf8")) as { entries?: Record<string, { compactionDerived?: Record<string, number> }> };
    for (const [file, entry] of Object.entries(managed.entries ?? {})) {
      const derived = entry?.compactionDerived;
      if (!derived || !Object.keys(derived).length) continue;
      let fileSettings: Record<string, unknown> | null = null;
      try {
        fileSettings = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        fileSettings = null;
      }
      const overrides = ((fileSettings?.compaction as { modelOverrides?: Record<string, { reserveTokens?: number }> } | undefined)?.modelOverrides) ?? {};
      const drifted = Object.keys(derived).filter((k) => overrides[k]?.reserveTokens !== derived[k]);
      if (drifted.length) out.push(failLine(`compaction override in ${file} differs from what setup wrote: ${drifted.join(", ")}`, "run /foreman setup; it keeps a value you set yourself and records it as yours."));
      else out.push(okLine(`compaction overrides written by setup in ${file} are in sync (${Object.keys(derived).length})`));
    }
  } catch {
    // no managed state yet: nothing to compare
  }
  if (piModelDataDir().error) out.push("INFO compaction: Pi model data not found; registry-derived overrides skipped (set PI_FOREMAN_PI_AI_DATA or PI_FOREMAN_PI_BIN)");
  return out;
}

/** The required child extensions' files (the registration with pi-subagents is a session fact and stays with the caller). */
export function childExtensionFileLines(list: readonly ChildExtension[]): string[] {
  const out: string[] = [];
  for (const e of list) {
    if (fs.existsSync(e.path) && fs.statSync(e.path).isFile()) out.push(okLine(`required child extension ${e.id}: ${e.path}`));
    else out.push(failLine(`required child extension ${e.id} not found at ${e.path}`, "install the package or correct safety.requiredChildExtensions."));
  }
  return out;
}

/** Keys the schema still accepts so old configs load but nothing reads. */
export function unusedKeyLines(config: unknown): string[] {
  const out: string[] = [];
  // The only reader of safety.git.commit.*: the keys are accepted so old configs load, nothing else may read them. Set means a non-blank string or a list with one.
  const commitKeySet = ["messagePattern", "requiredTrailers", "forbiddenTrailers", "checkCommand"].some((k) => {
    const v = get(config, `safety.git.commit.${k}`);
    return Array.isArray(v) ? v.some((x) => typeof x === "string" && x.trim() !== "") : typeof v === "string" && v.trim() !== "";
  });
  if (commitKeySet) out.push("INFO safety.git.commit.* is no longer used; commit messages are checked by the project's commit hooks");
  // Keys the schema still accepts so old configs load; the shipped defaults no longer set them, so a value here comes from a user or project layer.
  for (const k of ["gate.mode", "gate.askTimeoutMs", "gate.readClear", "gate.readonlyClear", "retro.proposalMinReviews"]) {
    if (get(config, k) !== undefined) out.push(`INFO ${k} is no longer used and has no effect`);
  }
  return out;
}

/** Host pressure: a fresh sample (the sampler timer's call); a missing probe is never a FAIL. `run` takes the sampler's arguments. */
export async function pressureLines(i: { agentDir: string; cwd: string; config: unknown; env: NodeJS.ProcessEnv; now: () => number; run: (args: string[]) => Promise<unknown> }): Promise<string[]> {
  try {
    const file = pressurePath(i.agentDir);
    const args = ["sample", "--workspace", i.cwd, "--state", file, "--limits", JSON.stringify(limitsOf(i.config))];
    const fx = i.env[PRESSURE_FIXTURE_ENV]?.trim();
    if (fx) args.push("--fixture", fx);
    await i.run(args);
  } catch {
    // fall through to the stored file
  }
  return [pressureDoctorLine(readPressure(pressurePath(i.agentDir), sampleSecondsOf(i.config), i.now()))];
}

/** The claude-bridge config checks (project, user, load order in settings.json) and the intercom guard. */
export function bridgeLines(i: { agentDir: string; cwd: string; pkgRoot: string; settings: Record<string, unknown> | null; env: NodeJS.ProcessEnv }): string[] {
  const out: string[] = [];
  const bridgeTrust = bridgeTrusted(i.agentDir, i.cwd);
  const bridgeCfg = bridgeTrust ? [] : projectBridgeConfigRisks(i.cwd);
  if (bridgeTrust) out.push(okLine("project .pi/claude-bridge.json is trusted by the owner (bridge-trust.json, hash matches)"));
  else if (bridgeCfg.length) out.push(failLine(`project claude-bridge config: ${bridgeCfg.join(", ")}`, PROJECT_BRIDGE_FIX));
  else out.push(okLine("no executable path, AskClaude or strictMcpConfig false in .pi/claude-bridge.json"));
  const userBridge = userBridgeConfigRisks(i.agentDir);
  const userBridgeFile = path.join(i.agentDir, "claude-bridge.json");
  if (userBridge.fail.length) out.push(failLine(`user claude-bridge config ${userBridgeFile}: ${userBridge.fail.join(", ")}`, "remove them unless you meant them: AskClaude runs Claude Code with the project's settings and bypassPermissions, and strictMcpConfig false loads project MCP servers in every bridge turn."));
  if (userBridge.warn.length) out.push(`WARN user claude-bridge config ${userBridgeFile} sets ${userBridge.warn.join(", ")}: claude-bridge starts that program for every turn and summary. Fine if you set it on purpose; pi-foreman asks before bridge use when this file changes.`);
  if (!userBridge.fail.length && !userBridge.warn.length) out.push(okLine("no executable path, AskClaude or strictMcpConfig false in the user claude-bridge config"));
  let projectSettings: Record<string, unknown> | null = null;
  try {
    projectSettings = JSON.parse(fs.readFileSync(path.join(i.cwd, ".pi", "settings.json"), "utf8"));
  } catch {
    projectSettings = null;
  }
  const order = bridgeLoadOrder(projectSettings?.packages, i.settings?.packages, i.pkgRoot, path.join(i.cwd, ".pi"), i.agentDir);
  if (order === "bridge-first") out.push(failLine("pi-claude-bridge loads before pi-foreman, so its compaction and branch-summary takeover runs before pi-foreman's config-drift check", "list pi-foreman before pi-claude-bridge in settings.json packages."));
  else if (order === "foreman-first") out.push(okLine("pi-foreman loads before pi-claude-bridge (the drift check precedes the bridge's summaries)"));
  else if (order === "unknown") out.push("INFO load order of pi-foreman and pi-claude-bridge not found in settings.json packages");
  out.push(...intercomDoctor(i.agentDir, [i.settings?.packages, projectSettings?.packages], i.env, i.pkgRoot));
  return out;
}

/** The permission store, its migration notes, the hub workflow drift, the herdr mods and project agents that shadow a role. */
export function permissionLines(i: { store: PermStore; agentDir: string; cwd: string; pkgRoot: string; config: unknown; env: NodeJS.ProcessEnv; homedir: string }): string[] {
  const out: string[] = [];
  const pr = i.store.resolve();
  out.push(`INFO permissions: ${pr.protected.length} protected targets, ${pr.prose.deny.length} deny sentences; decision log ${gateLogFile(i.agentDir)}`);
  const perLayer = (src: string): number => pr.allow.filter((e) => e.source === src).length;
  out.push(`INFO permissions: ${pr.allow.length} allow sentences (user ${perLayer("user")}, project ${perLayer("project")})`);
  for (const n of pr.allowNotes) out.push(`WARN permissions: ${n}`);
  if (pr.allow.length > ALLOW_WARN_ENTRIES) {
    const chars = pr.allow.reduce((n, e) => n + e.text.length, 0);
    out.push(`WARN permissions: ${pr.allow.length} allow sentences (${chars} characters, about ${Math.ceil(chars / 4)} tokens) go to the judge with every call; each judge call gets slower and more expensive above ${ALLOW_WARN_ENTRIES}`);
  }
  for (const k of pr.ignored) out.push(`INFO permissions: ${k} is no longer used and is ignored (the judge-first list replaces modes, profiles and rule lists)`);
  const profileSet = get(i.config, "permissions.profile");
  if (typeof profileSet === "string" && profileSet.trim() !== "") out.push("INFO permissions: permissions.profile is no longer used and is ignored (the judge-first list replaces modes, profiles and rule lists)");
  if (fs.existsSync(i.store.filePath("project"))) {
    const why = i.store.projectDistrust();
    if (why) out.push(`WARN ${i.store.filePath("project")}: ${why}; its widening keys (allow, additionalDirectories, classifier.allow) are ignored`);
  }
  out.push(...hubWorkflowDriftLines({ hubWorkflow: get(i.config, "paths.hubWorkflow") }));
  out.push(...gateMigrationLines({ agentDir: i.agentDir, config: i.config }));
  out.push(...modsDoctorLines({ packageRoot: i.pkgRoot, appHome: doctorAppHome(i.env, i.homedir) }));
  for (const sh of shadowedRoles(i.cwd, childRoleIds(get(i.config, "roles")))) out.push(`WARN project agent shadows a role (${sh}) — fix: ${SHADOW_FIX}`);
  return out;
}

/** The PR feed is on: radar.openPrs.enabled is not false and tools.prHost is auto or gh (what the search refresher and `foreman prs poll` require). */
export function prFeedOnConfig(config: unknown): boolean {
  const h = get(config, "tools.prHost") ?? "auto";
  return openPrsConfig(get(config, "radar.openPrs")).enabled && (h === "auto" || h === "gh");
}

/** The PR tracker line: feed state, host config errors and the age of the last poll. */
export function trackerLine(config: unknown, agentDir: string, now: number): string {
  const hosts = resolveGithubHosts(config as Json);
  return trackerDoctorLine(prFeedOnConfig(config), "error" in hosts ? hosts.error : undefined, lastPollAgeMs(agentDir, now));
}

/** The background-tasks add-on: present or absent (tool or package folder) and its features. */
export function addonHeadLines(i: { toolNames: readonly string[]; agentDir: string; cwd: string; env: NodeJS.ProcessEnv }): string[] {
  const addonOn = addonPresent(i.toolNames, { agentDir: i.agentDir, cwd: i.cwd });
  return [`INFO background-tasks: ${addonOn ? "present" : "absent"}`, ...bgFeaturesDoctor(addonOn, i.agentDir, i.env)];
}

/** The add-on's peer range against `piVersion` (null: not known) and the optional quiver and memory add-ons. */
export function addonTailLines(i: { toolNames: readonly string[]; agentDir: string; cwd: string; pkgRoot: string; env: NodeJS.ProcessEnv; piVersion: string | null }): string[] {
  const out: string[] = [];
  const peerLine = addonPeerRangeLine({ agentDir: i.agentDir, cwd: i.cwd, bundledRoot: i.pkgRoot }, i.piVersion);
  if (peerLine) out.push(peerLine);
  out.push(...optionalAddonsDoctor({ agentDir: i.agentDir, cwd: i.cwd }, i.toolNames, i.env));
  return out;
}

/** The profile and its deviations; read without the project layer (the agent dir has no .pi/foreman.json), so project tightening is not noise. */
export async function profileLines(i: { python: string | null; pkgRoot: string; agentDir: string; config: MergedConfig; spawner: Spawner }): Promise<string[]> {
  const userOnly = i.python ? await loadMergedConfig({ python: i.python, pkgRoot: i.pkgRoot, agentDir: i.agentDir, projectDir: i.agentDir, trusted: false, spawner: i.spawner }) : null;
  return profileDoctorLines(userOnly && userOnly.source === "cli" ? userOnly.config : i.config.config, i.config.config, i.pkgRoot);
}
