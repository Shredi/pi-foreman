// Once-guard and overlay handshake for the core adapter (docs/overlays.md, docs/install.md#developing).
// Two copies of this extension can load in one Pi process (an installed package and a checkout). The first
// claims a process-wide key; a copy from another root registers nothing but one notice. Pi re-runs the
// factory on /reload and session replacement, so the same root re-claims and the owner releases at shutdown.
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

/** Bundled packages without a package.json under `<pkgRoot>/node_modules` (a failed npm install drops them silently). */
export function missingBundled(pkgRoot: string): string[] {
  return BUNDLED_PACKAGES.filter((name) => !fs.existsSync(path.join(pkgRoot, "node_modules", ...name.split("/"), "package.json")));
}
