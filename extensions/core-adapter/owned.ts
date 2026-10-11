// Owned paths outside the workspace (harness-friction, ledger items 1, 2, 12; docs/permissions.md,
// "Owned paths"). One pure source for the dirs the foreman session owns, shared by the overlay
// (children are kept out), the shell write guard (`--allow-dir`), `foreman_wait` file paths and
// the recheck exemptions. The permission-system policy that grants the same dirs is rendered
// from config/permissions.baseline.json (scripts/permissions_gen.py); keep the two in step.
import * as path from "node:path";
import { SCRATCH_DIR_NAME } from "./childscratch.ts";
import type { Spawner } from "./spawn.ts";

export interface OwnedRoots {
  /** Read and write for the foreman. `sessions/*` is a wildcard segment (one dir per session). */
  readWrite: string[];
  /** Read only (reads of any role). */
  readOnly: string[];
  /** `<tmpRoot>/pi-foreman-scratch`: each child owns only its own subdir (`$FOREMAN_SCRATCH`). */
  childScratchRoot: string;
}

export interface OwnedInput {
  agentDir: string;
  /** Root of the workspace (worktree root for a worktree). */
  workspaceRoot: string;
  /** The OS temp dir, resolved the way childscratch.ts resolves it (realpath). */
  tmpRoot: string;
  npmRoot?: string | null;
}

export function ownedRoots(i: OwnedInput): OwnedRoots {
  const ws = path.resolve(i.workspaceRoot);
  const readWrite = [
    path.join(i.agentDir, "pi-foreman", "handoffs"),
    path.join(i.agentDir, "sessions", "*", "subagent-artifacts"),
    path.join(path.dirname(ws), `${path.basename(ws)}.worktrees`),
  ];
  const readOnly = [path.join(i.agentDir, "pi-foreman"), path.join(i.agentDir, "foreman.json"), path.join(i.agentDir, "settings.json")];
  if (i.npmRoot) readOnly.push(path.resolve(i.npmRoot));
  return { readWrite, readOnly, childScratchRoot: path.join(i.tmpRoot, SCRATCH_DIR_NAME) };
}

/** `p` is `root` or below it; `root` may carry `*` segments (matching one path segment). */
export function underOwned(root: string, p: string, platform: string = process.platform): boolean {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const fold = (x: string): string => (platform === "win32" || platform === "darwin" ? x.toLowerCase() : x);
  const r = fold(impl.resolve(root)).split(impl.sep);
  const t = fold(impl.resolve(p)).split(impl.sep);
  if (t.length < r.length) return false;
  return r.every((seg, n) => (seg === "*" ? t[n] !== "" : seg === t[n]));
}

export interface NpmRootInput {
  spawn: Spawner;
  env: Record<string, string | undefined>;
  platform: string;
  execPath: string;
}

export const NPM_ROOT_TIMEOUT_MS = 4000;

/**
 * The global npm root: `npm root -g` (4 s cap), else `npm_config_prefix`, else the prefix of the
 * running node binary, POSIX `<prefix>/lib/node_modules`, Windows `<prefix>\node_modules` or
 * `%AppData%\npm\node_modules`. Null when nothing resolves. No environment override of the
 * result. The caller runs it once per session and keeps the promise.
 */
export async function resolveNpmRoot(i: NpmRootInput): Promise<string | null> {
  const win = i.platform === "win32";
  const impl = win ? path.win32 : path.posix;
  try {
    const r = await i.spawn(win ? "npm.cmd" : "npm", ["root", "-g"], { timeoutMs: NPM_ROOT_TIMEOUT_MS });
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!r.error && !r.timedOut && r.code === 0 && last && impl.isAbsolute(last)) return last;
  } catch {
    // fall through to the prefix
  }
  const prefix = i.env.npm_config_prefix || i.env.NPM_CONFIG_PREFIX;
  if (win) {
    if (prefix) return impl.join(prefix, "node_modules");
    return i.env.APPDATA ? impl.join(i.env.APPDATA, "npm", "node_modules") : null;
  }
  const base = prefix || (i.execPath ? impl.dirname(impl.dirname(i.execPath)) : "");
  return base ? impl.join(base, "lib", "node_modules") : null;
}
