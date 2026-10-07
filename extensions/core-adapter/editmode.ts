// Edit mode (ceremony.foremanEdits): what the foreman may change itself, before triage.
//   readonly   -> only below a real `.workflow/` folder (harness ledger and notes)
//   scratchpad -> `.workflow/` and the real ceremony.scratchDir (notes, drafts, commit messages)
//   bounded    -> no check here: the triage gate and the trivial bound decide (triage.ts, bound.ts)
// The path test is triage.ts's own (workspaceTargets + realDeep): a symlink cannot carry a write
// out of the scratch dir, and a scratch dir that resolves outside the workspace (or to its root)
// is not writable at all. The shell layer gets the same dirs (allowedShellDirs).
import * as path from "node:path";
import { GATED_TOOLS, realDeep, under, workspaceTargets } from "./triage.ts";
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

/** The real scratch folder, or null when it resolves outside the workspace or to its root. */
export function scratchRoot(realRoot: string, scratchDir: string, platform: string): string | null {
  const parts = scratchParts(scratchDir);
  if (!parts) return null;
  const real = realDeep(path.join(realRoot, ...parts));
  return under(realRoot, real, platform) && path.relative(realRoot, real) !== "" ? real : null;
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
  const realRoot = realDeep(path.resolve(workspaceOf(opts.cwd).root));
  const scratch = mode === "scratchpad" ? scratchRoot(realRoot, scratchDir, opts.platform) : null;
  // workspaceTargets already drops paths below a real `.workflow/` and outside the workspace
  const refused = workspaceTargets(toolName, input, opts.cwd, opts.home, opts.platform).filter((t) => {
    if (!scratch) return true;
    const real = realDeep(t.abs);
    return !(under(scratch, real, opts.platform) && real !== scratch);
  });
  if (refused.length === 0) return "";
  return `pi-foreman: ${toolName} on '${refused[0].raw}' refused: ${editModeAdvice(mode, scratchDir)}.`;
}
