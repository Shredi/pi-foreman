// `foreman doctor` (bin/foreman, .cmd, .ps1): the file, config and environment checks of `/foreman doctor` without a running Pi, from the same
// functions (doctorlines.ts). A check that needs the Pi session (models, login, loaded tools, session state) prints an INFO line that says
// so, never FAIL. Exit 0: no FAIL line; 1: at least one; 2: usage error. `foreman doctor warm` stays slash-only. Read-only apart from the
// pressure sampler's state file, as in the slash command.
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { get, loadMergedConfig, pythonPathHint } from "./config.ts";
import { requiredChildExtensions } from "./childext.ts";
import { addonHeadLines, addonTailLines, bridgeLines, childExtensionFileLines, compactionLines, configLines, installLines, permissionLines, pressureLines, profileLines, subagentsLines, trackerLine, unusedKeyLines } from "./doctorlines.ts";
import { piAgentDir } from "./env.ts";
import { dormantDoctorLine } from "./features.ts";
import { npmRootOnce } from "./owned.ts";
import { pageServerDoctorLine } from "./pageserver.ts";
import { PermStore } from "./permconfig.ts";
import { resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";

export const USAGE = "usage: foreman doctor";
const WARM_USAGE = "foreman doctor warm is slash-only: run /foreman doctor warm in Pi (it sends two paid requests and asks first).";
const NEEDS_PI = "needs a running Pi: run /foreman doctor";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

export interface DoctorDeps {
  agentDir: string;
  cwd: string;
  pkgRoot: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  spawner: Spawner;
  /** The Python lookup for a configured path (null: none), as the session resolves it. */
  resolve(configPath: string | null): Promise<PythonResolution>;
  /** The global npm root (a protected root of the worktree-root check); null when unknown. */
  npmRoot(): Promise<string | null>;
  now: () => number;
  /** The pressure sampler call; unset runs foreman_pressure.py with the resolved Python. */
  pressureRun?: (args: string[]) => Promise<unknown>;
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): DoctorDeps {
  const homedir = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const cwd = process.cwd();
  const spawner = defaultSpawner;
  return {
    agentDir: piAgentDir(env, homedir),
    cwd,
    pkgRoot: PKG_ROOT,
    platform: process.platform,
    env,
    homedir,
    spawner,
    resolve: (configPath) => resolvePython({ configPath, envPath: env.PI_FOREMAN_PYTHON, platform: process.platform, spawner, cwd }),
    npmRoot: () => npmRootOnce({ spawn: spawner, env, platform: process.platform, execPath: process.execPath }),
    now: Date.now,
  };
}

/** The doctor lines (without the heading) for `d`, in the order of `/foreman doctor`. */
export async function doctorLines(d: DoctorDeps): Promise<string[]> {
  const out: string[] = [];
  const hint = pythonPathHint(d.pkgRoot, d.agentDir);
  let python = await d.resolve(hint);
  const pyOf = (): string | null => (python.ok ? python.info.executable : null);
  // no provider and not trusted: the model-specific roles and the project layer are a session's
  const config = await loadMergedConfig({ python: pyOf(), pkgRoot: d.pkgRoot, agentDir: d.agentDir, projectDir: d.cwd, trusted: false, spawner: d.spawner });
  const merged = get(config.config, "python.path");
  if (typeof merged === "string" && merged.trim() && merged !== hint) python = await d.resolve(merged);

  out.push(...installLines({ python, coreDir: path.join(d.pkgRoot, "core"), pkgRoot: d.pkgRoot, agentDir: d.agentDir, cwd: d.cwd, platform: d.platform, config: config.config, roots: { installRoot: null, npmRoot: await d.npmRoot() } }));
  out.push(...configLines(config));
  out.push("INFO config read without a provider and without the project layer (a session adds both)");
  const sub = await subagentsLines({ python: pyOf(), pkgRoot: d.pkgRoot, agentDir: d.agentDir, cwd: d.cwd, trusted: false, spawner: d.spawner });
  out.push(...sub.lines);
  out.push(...compactionLines(d.agentDir));
  out.push(...childExtensionFileLines(requiredChildExtensions(get(config.config, "safety.requiredChildExtensions"), d.agentDir, path.join(HERE, "index.ts")).list));
  out.push(...unusedKeyLines(config.config));
  const py = pyOf();
  out.push(...(await pressureLines({
    agentDir: d.agentDir,
    cwd: d.cwd,
    config: config.config,
    env: d.env,
    now: d.now,
    run: d.pressureRun ?? (async (a) => (py ? d.spawner(py, ["-X", "utf8", "-E", "-s", path.join(d.pkgRoot, "scripts", "foreman_pressure.py"), ...a], { timeoutMs: 20_000, cwd: d.cwd }) : undefined)),
  })));
  out.push(`INFO models, login, rank policy, classifier model and idle cache: ${NEEDS_PI}`);
  out.push(...bridgeLines({ agentDir: d.agentDir, cwd: d.cwd, pkgRoot: d.pkgRoot, settings: sub.settings, env: d.env }));
  out.push(...permissionLines({ store: new PermStore({ agentDir: d.agentDir, cwd: d.cwd, home: d.homedir }), agentDir: d.agentDir, cwd: d.cwd, pkgRoot: d.pkgRoot, config: config.config, env: d.env, homedir: d.homedir }));
  out.push(`INFO session state (child extension registration, marker, ceremony tier, sidebar, loaded tools): ${NEEDS_PI}`);
  if (get(config.config, "tools.pr") === true) out.push(trackerLine(config.config, d.agentDir, d.now()));
  out.push(await pageServerDoctorLine(config.config as Record<string, unknown>, d.agentDir));
  out.push(...addonHeadLines({ toolNames: [], agentDir: d.agentDir, cwd: d.cwd, env: d.env }));
  out.push(...addonTailLines({ toolNames: [], agentDir: d.agentDir, cwd: d.cwd, pkgRoot: d.pkgRoot, env: d.env, piVersion: null }));
  out.push(dormantDoctorLine(d.pkgRoot, config.config));
  out.push(...(await profileLines({ python: pyOf(), pkgRoot: d.pkgRoot, agentDir: d.agentDir, config, spawner: d.spawner })));
  return out;
}

/** The CLI: argv after `doctor`. Returns the exit code. */
export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void, deps: () => DoctorDeps = realDeps): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    out(`${USAGE}\n`);
    return 0;
  }
  if (argv.length > 0) {
    err(`${USAGE}\n${argv[0] === "warm" ? `${WARM_USAGE}\n` : ""}`);
    return 2;
  }
  const lines = await doctorLines(deps());
  out(`${["pi-foreman doctor", ...lines].join("\n")}\n`);
  return lines.some((l) => l.startsWith("FAIL")) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
