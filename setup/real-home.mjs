// The guard that keeps a test from writing the real default places. Under the Node test runner (NODE_TEST_CONTEXT is set in every `node --test` child)
// setup refuses to write or remove the real shell startup files, PowerShell profile folders, Pi agent dir and herdr-app home, unless
// PI_FOREMAN_ALLOW_REAL_HOME=1. Pure over its inputs: the real home is a parameter, so tests never touch a real place.
import * as os from "node:os";
import * as path from "node:path";

/** The account's real home: the user database (POSIX: ignores a test's HOME; Windows: the token profile), `os.homedir()` when there is no entry. */
export function realHomeDir({ userInfo = os.userInfo, homedir = os.homedir } = {}) {
  try {
    const h = userInfo().homedir;
    if (h) return h;
  } catch {
    // a uid without a passwd entry: protect the environment's home rather than crash
  }
  return homedir();
}

/** The startup files the resume hook (resume-hook.mjs resumeTargets) and the env block (persist-env.mjs envTarget) write under `home`. */
export function startupFiles(home) {
  return [
    ".zshrc", ".bashrc", ".bash_profile", ".bash_login", ".profile",
    path.join(".config", "fish", "conf.d", "pi-foreman-resume.fish"),
    path.join(".config", "fish", "conf.d", "pi-foreman.fish"),
  ].map((f) => path.join(home, f));
}

/** The places a test must not write: the real startup files, PowerShell profile folders, agent dir and herdr-app home under `realHome`. */
export function protectedPlaces(realHome, platform = process.platform) {
  void platform;
  return [
    ...startupFiles(realHome),
    path.join(realHome, "Documents", "PowerShell"),
    path.join(realHome, "Documents", "WindowsPowerShell"),
    path.join(realHome, ".pi", "agent"),
    path.join(realHome, ".config", "herdr-app"),
  ];
}

const QUERY_TARGET = "<the PowerShell Documents folder query: Windows answers with a real place>";

/**
 * The paths (and the PowerShell Documents query) one setup run writes or removes. `platform` is setup's effective platform (PI_FOREMAN_PLATFORM when set).
 * `agentDir` null leaves the agent dir out (`--mods`), `appHome` null leaves the herdr-app home out, `home` null leaves the home-level files out.
 */
export function writeTargets({ env = process.env, home, agentDir = null, platform = process.platform, appHome = null }) {
  const out = [];
  if (home) {
    out.push(...startupFiles(home));
    if (platform === "win32") {
      if (env.PI_FOREMAN_TEST_PS_DOCUMENTS) out.push(...["PowerShell", "WindowsPowerShell"].map((d) => path.join(env.PI_FOREMAN_TEST_PS_DOCUMENTS, d)));
      else if (env.PI_FOREMAN_HOME) out.push(...["PowerShell", "WindowsPowerShell"].map((d) => path.join(home, "Documents", d)));
      else out.push(QUERY_TARGET);
    }
  }
  if (agentDir) out.push(agentDir);
  if (appHome) out.push(appHome);
  return out;
}

const fold = (p, platform) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);

const inside = (place, target, platform) => {
  const rel = path.relative(fold(path.resolve(place), platform), fold(path.resolve(target), platform));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** The first target equal to or inside a protected place when the test runner signal is set and the override is not, else null. */
export function realHomeGuard({ env = process.env, targets, realHome, platform = process.platform }) {
  if (!env.NODE_TEST_CONTEXT || env.PI_FOREMAN_ALLOW_REAL_HOME === "1") return null;
  const places = protectedPlaces(realHome, platform);
  for (const t of targets) {
    if (t === QUERY_TARGET) return t;
    if (places.some((p) => inside(p, t, platform))) return t;
  }
  return null;
}

/**
 * Turns a guard result into the refusal (`fatal(message)` is thrown; exit code 2 in setup) or, on a dry run, the printed line `real-home guard: would refuse <path>`.
 * `fatal` builds the error (setup passes its Fatal).
 */
export function applyRealHomeGuard(refused, dry, { fatal = (m) => Object.assign(new Error(m), { code: 2 }), say = console.log } = {}) {
  if (refused === null || refused === undefined) return;
  if (dry) {
    say(`real-home guard: would refuse ${refused}`);
    return;
  }
  throw fatal(`pi-foreman setup: refusing to write ${refused}: the Node test runner runs setup (NODE_TEST_CONTEXT is set) and this is a real default place. Point HOME/PI_FOREMAN_HOME and --agent-dir at a temp dir, or set PI_FOREMAN_ALLOW_REAL_HOME=1.${refused === QUERY_TARGET ? " For the PowerShell Documents folder set PI_FOREMAN_TEST_PS_DOCUMENTS to a temp dir (HOME does not help on Windows)." : ""}`);
}
