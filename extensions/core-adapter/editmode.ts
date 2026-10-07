// Edit mode (ceremony.foremanEdits): what the foreman may change itself, before triage.
//   readonly   -> only below a real `.workflow/` folder (harness ledger and notes)
//   scratchpad -> `.workflow/` and the real ceremony.scratchDir (notes, drafts, commit messages)
//   bounded    -> no check here: the triage gate and the trivial bound decide (triage.ts, bound.ts)
// The path test is triage.ts's own (workspaceTargets + realDeep): a symlink cannot carry a write
// out of the scratch dir, and a scratch dir with a symlink in any component below the workspace
// root (real path != lexical path) is not writable at all. An existing target with more than one
// hard link is refused (an in-place write would change the other names too). The shell layer gets
// the same dirs (allowedShellDirs).
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveToolPath } from "./payload.ts";
import { changedPaths, GATED_TOOLS, realDeep, under, workspaceTargets } from "./triage.ts";
import { workspaceOf } from "./python.ts";

export type EditMode = "readonly" | "scratchpad" | "bounded";
export const EDIT_MODES: readonly EditMode[] = ["readonly", "scratchpad", "bounded"];
export const DEFAULT_SCRATCH_DIR = ".workflow/scratch";

/** The configured mode; missing = scratchpad (the default), anything unknown = readonly (fail closed). */
export function editModeOf(value: unknown): EditMode {
  if (value === undefined || value === null) return "scratchpad";
  return (EDIT_MODES as readonly unknown[]).includes(value) ? (value as EditMode) : "readonly";
}

/** Workspace-relative path parts of a scratch dir, or null (absolute, `..`, the root, not a string). */
export function scratchParts(value: unknown): string[] | null {
  if (typeof value !== "string" || /^([\\/]|[A-Za-z]:)/.test(value)) return null;
  const parts = value.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  return parts.length === 0 || parts.includes("..") ? null : parts;
}

/** The configured scratch dir as given (default when invalid). */
export function scratchDirOf(value: unknown): string {
  return scratchParts(value) ? (value as string) : DEFAULT_SCRATCH_DIR;
}

/** True when no component of `abs` (a path below the real root) is a symlink: its real path is the lexical one. */
function noLink(abs: string, platform: string): boolean {
  const fold = platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(realDeep(abs)) === fold(abs);
}

/** Why the scratch dir is disabled, or "" when it is usable. */
export function scratchProblem(realRoot: string, scratchDir: string, platform: string): string {
  const parts = scratchParts(scratchDir);
  if (!parts) return "not a workspace-relative folder";
  const lexical = path.join(realRoot, ...parts);
  if (!noLink(lexical, platform)) return "it passes through a symlink";
  return path.relative(realRoot, lexical) !== "" ? "" : "it is the workspace root";
}

/** The real scratch folder, or null when it is disabled (scratchProblem). */
export function scratchRoot(realRoot: string, scratchDir: string, platform: string): string | null {
  return scratchProblem(realRoot, scratchDir, platform) ? null : path.join(realRoot, ...(scratchParts(scratchDir) as string[]));
}

/**
 * True when a foreman file-tool call changes a project file: a workspace target (workspaceTargets,
 * which also feeds the trivial tally) that is not under `.workflow/` nor the real scratch dir.
 */
export function projectChange(toolName: string, input: Record<string, unknown>, scratchDir: string, opts: { cwd: string; home: string; platform: string }): boolean {
  if (!GATED_TOOLS.has(toolName)) return false;
  const realRoot = realDeep(path.resolve(workspaceOf(opts.cwd).root));
  const scratch = scratchRoot(realRoot, scratchDir, opts.platform);
  return workspaceTargets(toolName, input, opts.cwd, opts.home, opts.platform).some((t) => {
    const real = realDeep(t.abs);
    return !(scratch && under(scratch, real, opts.platform) && real !== scratch);
  });
}

/** Changed paths of a gated tool that exist as a file with more than one hard link (a write would land in the other names too). */
function hardLinked(toolName: string, input: Record<string, unknown>, cwd: string, home: string): string[] {
  const out: string[] = [];
  for (const raw of changedPaths(toolName, input)) {
    const abs = resolveToolPath(raw, cwd, home);
    if (!abs) continue;
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.nlink > 1) out.push(String(raw));
    } catch {
      // missing: a new file has no other names
    }
  }
  return out;
}

/** Dirs the shell write scanner keeps writable (`allowed_dirs`): bounded keeps plan D3. */
export function allowedShellDirs(mode: EditMode, scratchDir: string, cwd: string, platform: string): string[] {
  if (mode !== "scratchpad") return [".workflow"];
  const realRoot = realDeep(path.resolve(workspaceOf(cwd).root));
  return scratchRoot(realRoot, scratchDir, platform) ? [".workflow", scratchDir] : [".workflow"];
}

/** What a refusal tells the foreman: where it may write, and that the change goes to a builder. */
export function editModeAdvice(mode: EditMode, scratchDir: string): string {
  return mode === "scratchpad"
    ? `foreman edits are scratchpad: delegate to a builder (scratch: ${scratchDir}; .workflow/ stays writable)`
    : `foreman edits are readonly: delegate to a builder (scratch: none, only .workflow/ is writable)`;
}

/**
 * Block reason for a foreman file-tool call under the edit mode, "" when the call may go on,
 * or null in bounded mode (the triage gate and the trivial bound decide).
 */
export function editModeBlock(toolName: string, input: Record<string, unknown>, mode: EditMode, scratchDir: string, opts: { cwd: string; home: string; platform: string }): string | null {
  if (mode === "bounded") return null;
  if (!GATED_TOOLS.has(toolName)) return "";
  const linked = hardLinked(toolName, input, opts.cwd, opts.home);
  if (linked.length) return `pi-foreman: ${toolName} on '${linked[0]}' refused: hard-linked file: delegate to a builder.`;
  const realRoot = realDeep(path.resolve(workspaceOf(opts.cwd).root));
  const problem = mode === "scratchpad" ? scratchProblem(realRoot, scratchDir, opts.platform) : "";
  const scratch = mode === "scratchpad" && !problem ? path.join(realRoot, ...(scratchParts(scratchDir) as string[])) : null;
  // workspaceTargets already drops paths below a real `.workflow/` and outside the workspace
  // (a symlinked `.workflow` never contains a real target, so it is disabled there)
  const refused = workspaceTargets(toolName, input, opts.cwd, opts.home, opts.platform).filter((t) => {
    if (!scratch) return true;
    const real = realDeep(t.abs);
    return !(under(scratch, real, opts.platform) && real !== scratch);
  });
  if (refused.length === 0) return "";
  const why: string[] = [];
  if (!noLink(path.join(realRoot, ".workflow"), opts.platform)) why.push(".workflow/ is disabled: it passes through a symlink");
  if (problem) why.push(`scratch dir ${scratchDir} is disabled: ${problem}`);
  return `pi-foreman: ${toolName} on '${refused[0].raw}' refused: ${editModeAdvice(mode, scratchDir)}${why.length ? ` (${why.join("; ")})` : ""}.`;
}
