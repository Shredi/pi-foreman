// Once-guard and overlay handshake for the core adapter (docs/overlays.md, docs/install.md#developing).
// Two copies of this extension can load in one Pi process (an installed package and a checkout). The first
// claims a process-wide key; a copy from another root registers nothing but one notice. Pi re-runs the
// factory on /reload and session replacement, so the same root re-claims and the owner releases at shutdown.
// Trust bootstrap: Pi first loads the user-level extensions with the project untrusted, then (once the project
// is trusted) loads the final set and drops pass-1 copies the project disables, without session_shutdown or
// session_start. In a --develop checkout the installed copy therefore leaves a stale claim before the checkout
// copy runs. A claimant takes over a held claim only when BOTH hold: the holder never saw session_start (a
// dropped pass-1 copy never does) and <cwd>/.pi/settings.json disables the holder with an empty-filter package
// override (the --develop override). The first condition alone is unsafe: two copies of one pass have both not
// started yet, and the second must stay inert. The second alone would steal from a live session.
// A takeover can also hit a holder Pi does not drop: the parent passes its own entry via --extension (a project
// setting cannot remove a CLI extension) into a child whose cwd is a develop checkout, so the checkout copy takes
// over while the first copy's handlers (registered at factory time) stay live. The takeover therefore records the
// displaced claim (DISPLACED_KEY); the displaced instance gates every handler on isDisplaced and stands down, so
// one adapter handles events. A same-root re-claim (/reload, in-process children) never displaces anything.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./herdr.ts";
import { piAgentDir } from "./env.ts";

export const CORE_KEY = Symbol.for("pi-foreman.core.v1");
/** Holds the claim object that saw its session_start (kept apart from CORE_KEY: the claim shape is a public handshake). */
export const STARTED_KEY = Symbol.for("pi-foreman.core.started.v1");
/** WeakMap of displaced claim -> the claim that took over (kept apart from CORE_KEY: the claim shape is a public handshake). */
export const DISPLACED_KEY = Symbol.for("pi-foreman.core.displaced.v1");
export const READY_EVENT = "foreman:ready";

export interface CoreClaim {
  version: string;
  pkgRoot: string;
  api: 1;
}

export type ClaimResult = { active: true; claim: CoreClaim; release: () => void } | { active: false; activeRoot: string; notice: string };

/** `version` of `<pkgRoot>/package.json`, "0.0.0" when unreadable. */
export function readVersion(pkgRoot: string): string {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Real path for comparison (runner short names, symlinks), case-folded on win32 and darwin. */
export function rootKey(p: string, platform: string = process.platform): string {
  let real: string;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    real = path.resolve(p);
  }
  return platform === "win32" || platform === "darwin" ? real.toLowerCase() : real;
}

export function inertNotice(activeRoot: string, skippedRoot: string): string {
  return `pi-foreman: two copies are loaded; the one at ${activeRoot} is active and the one at ${skippedRoot} is skipped (it registers nothing). To develop from a checkout, run foreman setup --develop there (docs/install.md#developing).`;
}

/** The active copy saw its first session_start: its claim can no longer be taken over. */
export function markCoreStarted(claim: CoreClaim, g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>): void {
  g[STARTED_KEY] = claim;
}

/** The claim that displaced `claim` through a different-root takeover, or undefined. */
export function displacedBy(claim: CoreClaim, g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>): CoreClaim | undefined {
  return (g[DISPLACED_KEY] as WeakMap<object, CoreClaim> | undefined)?.get(claim);
}

/** Was this claim taken over by another root? A displaced instance must stand down. */
export function isDisplaced(claim: CoreClaim, g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>): boolean {
  return displacedBy(claim, g) !== undefined;
}

const isForemanRoot = (root: string): boolean => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown }).name === "pi-foreman";
  } catch {
    return false;
  }
};

/**
 * Pi's package identity (package-manager.js getPackageIdentity) for the source kinds that matter here: `npm:<name>`,
 * `git:<host>/<path>`, `local:<resolved path>` (no realpath; case-folded on win32 only). Unparseable => undefined.
 */
export function packageIdentity(source: string, baseDir: string, platform: string = process.platform): string | undefined {
  const src = source.trim();
  if (src.startsWith("npm:")) {
    const m = src.slice(4).trim().match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    return `npm:${m?.[1] ?? src.slice(4).trim()}`;
  }
  if (/^(npm|github|http|https|ssh|builtin|file):/.test(src) === false && !src.startsWith("git:")) {
    const home = os.homedir();
    const expanded = src === "~" ? home : src.startsWith("~/") ? path.join(home, src.slice(2)) : src;
    const resolved = path.resolve(baseDir, expanded);
    return `local:${platform === "win32" ? resolved.toLowerCase() : resolved}`;
  }
  let url = src.startsWith("git:") ? src.slice(4).trim() : src;
  if (!src.startsWith("git:") && !/^(https?|ssh|git):\/\//i.test(url)) return undefined;
  url = url.replace(/^(https?|ssh|git):\/\//i, "").replace(/^[^/@:]+@/, "").replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  const slash = url.indexOf("/");
  if (slash < 0) return undefined;
  const host = url.slice(0, slash).replace(/:\d+$/, "");
  const p = url.slice(slash + 1).replace(/@[^/]*$/, "").replace(/#.*$/, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  return host && p.split("/").length >= 2 ? `git:${host}/${p}` : undefined;
}

const isForemanRemoteIdentity = (id: string): boolean => id === "npm:pi-foreman" || /^git:[^/]+\/(.+\/)?pi-foreman$/.test(id);

const packageEntries = (file: string): { source: string; obj?: Record<string, unknown> }[] => {
  let pk: unknown;
  try {
    pk = (JSON.parse(fs.readFileSync(file, "utf8")) as { packages?: unknown }).packages;
  } catch {
    return [];
  }
  if (!Array.isArray(pk)) return [];
  const out: { source: string; obj?: Record<string, unknown> }[] = [];
  for (const e of pk) {
    if (typeof e === "string") out.push({ source: e });
    else if (e && typeof e === "object" && typeof (e as { source?: unknown }).source === "string") out.push({ source: (e as { source: string }).source, obj: e as Record<string, unknown> });
  }
  return out;
};

/**
 * Does Pi drop the holder's user-level entry in favour of an empty-filter project entry? True only when a project entry P
 * (`extensions: []`, not `autoload: false`) in `<cwd>/.pi/settings.json` and a user entry G in `<agentDir>/settings.json` have
 * the same Pi package identity AND G is the holder (local: same real path as the holder root; remote: the holder is a
 * pi-foreman package). Anything uncertain answers false (the claimant stays inert).
 */
export function projectDisables(holderRoot: string, claimantRoot: string, cwd: string, platform: string = process.platform, agentDir: string = piAgentDir(process.env, os.homedir())): boolean {
  const project = packageEntries(path.join(cwd, ".pi", "settings.json")).filter((e) => e.obj && Array.isArray(e.obj.extensions) && e.obj.extensions.length === 0 && e.obj.autoload !== false);
  if (!project.length) return false;
  const globals = packageEntries(path.join(agentDir, "settings.json"));
  for (const p of project) {
    const pid = packageIdentity(p.source, path.join(cwd, ".pi"), platform);
    if (!pid) continue;
    for (const g of globals) {
      if (packageIdentity(g.source, agentDir, platform) !== pid) continue;
      if (pid.startsWith("local:")) {
        const resolved = path.resolve(agentDir, g.source.trim() === "~" ? os.homedir() : g.source.trim().startsWith("~/") ? path.join(os.homedir(), g.source.trim().slice(2)) : g.source.trim());
        if (rootKey(resolved, platform) === rootKey(holderRoot, platform)) return true;
      } else if (isForemanRemoteIdentity(pid) && isForemanRoot(holderRoot) && rootKey(holderRoot, platform) !== rootKey(claimantRoot, platform)) return true;
    }
  }
  return false;
}

/** Claim the process-wide key for `pkgRoot`, or report the root that holds it. `cwd` is where the project settings are read for a takeover. */
export function claimCore(pkgRoot: string, g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>, platform: string = process.platform, cwd: string = process.cwd(), agentDir?: string): ClaimResult {
  const held = g[CORE_KEY] as Partial<CoreClaim> | undefined;
  let displaced: CoreClaim | undefined;
  if (held && typeof held.pkgRoot === "string" && rootKey(held.pkgRoot, platform) !== rootKey(pkgRoot, platform)) {
    const stale = g[STARTED_KEY] !== held && projectDisables(held.pkgRoot, pkgRoot, cwd, platform, agentDir);
    if (!stale) return { active: false, activeRoot: held.pkgRoot, notice: inertNotice(held.pkgRoot, pkgRoot) };
    displaced = held as CoreClaim;
  }
  const claim: CoreClaim = { version: readVersion(pkgRoot), pkgRoot, api: 1 };
  if (displaced) {
    const map = (g[DISPLACED_KEY] as WeakMap<object, CoreClaim> | undefined) ?? new WeakMap<object, CoreClaim>();
    map.set(displaced, claim);
    g[DISPLACED_KEY] = map;
  }
  g[CORE_KEY] = claim;
  return { active: true, claim, release: () => { if (g[CORE_KEY] === claim) delete g[CORE_KEY]; } };
}

/** The inert copy: one session_start handler that posts the notice once. */
export function installInert(pi: Pick<ExtensionAPI, "on">, notice: string): void {
  let shown = false;
  pi.on("session_start", async (_e, ctx) => {
    if (shown) return;
    shown = true;
    ctx.ui.notify(notice, "warning");
  });
}

export function emitReady(events: EventBus | undefined, claim: CoreClaim): void {
  events?.emit(READY_EVENT, { version: claim.version, pkgRoot: claim.pkgRoot, api: claim.api });
}

/** `/foreman setup [args]`: node (this process's executable) runs the package's setup.mjs; no shell. */
export function setupInvocation(pkgRoot: string, args: string, agentDir: string, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): { command: string; args: string[]; env: Record<string, string> } {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") childEnv[k] = v;
  childEnv.PI_CODING_AGENT_DIR = agentDir;
  childEnv.PI_FOREMAN_PICKER = "off"; // piped output: an inherited `force` must never hang the run
  return { command: execPath, args: [path.join(pkgRoot, "setup.mjs"), ...args.trim().split(/\s+/).filter(Boolean)], env: childEnv };
}

/** Packages bundled as dependencies under `<pkgRoot>/node_modules` and loaded through the package manifest. */
export const BUNDLED_PACKAGES = ["pi-subagents", "pi-intercom", "@juicesharp/rpiv-ask-user-question"];

/** `./node_modules/...` entries of the package manifest (package.json `pi.*` arrays). */
export function manifestBundledEntries(pkgRoot: string): string[] {
  try {
    const pi = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).pi;
    if (!pi || typeof pi !== "object") return [];
    const flat = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(flat) : v && typeof v === "object" ? Object.values(v).flatMap(flat) : [v]);
    return flat(pi).filter((e): e is string => typeof e === "string" && e.startsWith("./node_modules/"));
  } catch {
    return [];
  }
}

/**
 * Bundled packages without a package.json under `<pkgRoot>/node_modules` (a failed npm install drops them silently),
 * plus every `./node_modules/...` manifest entry that does not resolve (a stale install after package.json changed).
 */
export function missingBundled(pkgRoot: string): string[] {
  const packages = BUNDLED_PACKAGES.filter((name) => !fs.existsSync(path.join(pkgRoot, "node_modules", ...name.split("/"), "package.json")));
  const entries = manifestBundledEntries(pkgRoot).filter((e) => !fs.existsSync(path.join(pkgRoot, e)));
  return [...packages, ...entries];
}

/** Worktree paths of `git worktree list --porcelain` output. */
export function worktreePaths(porcelain: string): string[] {
  return porcelain.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

/** Live worktrees of the repository at `cwd` whose node_modules is a symlink or junction (empty outside a git repository). */
export function symlinkedNodeModules(cwd: string): string[] {
  let listing = "";
  try {
    listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  return worktreePaths(listing).filter((wt) => {
    try {
      return fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

/** Is `worktreeSetupHook` set in pi-subagents' config (`<agentDir>/extensions/subagent/config.json`)? */
export function worktreeHookConfigured(agentDir: string): { file: string; configured: boolean } {
  const file = path.join(agentDir, "extensions", "subagent", "config.json");
  try {
    const hook = (JSON.parse(fs.readFileSync(file, "utf8")) as { worktreeSetupHook?: unknown }).worktreeSetupHook;
    return { file, configured: typeof hook === "string" && hook.trim() !== "" };
  } catch {
    return { file, configured: false };
  }
}

/** Doctor lines for the worktree node_modules problem (symlinked node_modules: a builder's `npm ci` rewrites the main checkout). */
export function worktreeDoctor(agentDir: string, cwd: string, platform: string): string[] {
  const out: string[] = [];
  if (platform !== "win32") {
    const h = worktreeHookConfigured(agentDir);
    if (!h.configured) out.push(`WARN worktreeSetupHook is not set in ${h.file}: pi-subagents symlinks node_modules into managed worktrees, so a builder's npm ci rewrites the main checkout — fix: run /foreman setup (registers bin/foreman-worktree-setup)`);
  }
  for (const wt of symlinkedNodeModules(cwd)) out.push(`WARN node_modules is a symlink in ${wt} — fix: in that worktree run rm node_modules && npm ci (never npm ci through the link)`);
  return out;
}

/** The models.json entry that declares a prompt-cache lifetime for a built-in model (docs/cache.md). */
export function promptCacheSnippet(provider: string | undefined, modelId: string | undefined, shortSeconds: number): string {
  return JSON.stringify({ providers: { [provider ?? "<provider>"]: { modelOverrides: { [modelId ?? "<modelId>"]: { promptCache: { short: shortSeconds } } } } } });
}
