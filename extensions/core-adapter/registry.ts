// Once-guard and overlay handshake for the core adapter (docs/overlays.md, docs/install.md#developing).
// Two copies of this extension can load in one Pi process (an installed package and a checkout). The first
// claims a process-wide key; a copy from another root registers nothing but one notice. Pi re-runs the
// factory on /reload and session replacement, so the same root re-claims and the owner releases at shutdown.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./herdr.ts";

export const CORE_KEY = Symbol.for("pi-foreman.core.v1");
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

/** Claim the process-wide key for `pkgRoot`, or report the root that holds it. */
export function claimCore(pkgRoot: string, g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>, platform: string = process.platform): ClaimResult {
  const held = g[CORE_KEY] as Partial<CoreClaim> | undefined;
  if (held && typeof held.pkgRoot === "string" && rootKey(held.pkgRoot, platform) !== rootKey(pkgRoot, platform)) {
    return { active: false, activeRoot: held.pkgRoot, notice: inertNotice(held.pkgRoot, pkgRoot) };
  }
  const claim: CoreClaim = { version: readVersion(pkgRoot), pkgRoot, api: 1 };
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
  return { command: execPath, args: [path.join(pkgRoot, "setup.mjs"), ...args.trim().split(/\s+/).filter(Boolean)], env: childEnv };
}

/** Packages bundled as dependencies under `<pkgRoot>/node_modules` and loaded through the package manifest. */
export const BUNDLED_PACKAGES = ["pi-subagents", "@gotgenes/pi-permission-system", "pi-intercom"];

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
