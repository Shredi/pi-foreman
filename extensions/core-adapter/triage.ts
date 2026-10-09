// Triage enforced (plan D10): the foreman records a tier before it changes workspace files
// itself, and only a trivial task lets it do so. `foreman_triage` records the tier; the gate in
// the tool_call hook refuses write, edit, foreman_move (source and destination) and foreman_copy
// (destination) on paths inside the workspace while the tier is untriaged (config default or
// only escalated by a signal) or standard/heavy. `.workflow/**` (ledger, notes) stays writable.
//
// Paths: as given (resolveToolPath) and with symlinks resolved (fs.realpathSync.native, so Windows
// short names and `\\?\` forms compare too; deepest existing ancestor plus the missing tail), each checked against the workspace root as given and resolved. Either one
// inside counts, so a symlink cannot carry a write into the workspace. The `.workflow` exemption
// holds only when the resolved target is below the resolved root's real `.workflow` folder, so a
// link inside `.workflow` cannot carry a write out of it.
//
// LIMIT (documented, design/architecture.md): shell writes are not gated here but by
// scripts/shell_write_guard.py (string scan, blind spots listed there); the OS boundary covers the rest.
import * as fs from "node:fs";
import * as path from "node:path";
import type { CeremonyState, Tier } from "./ceremony.ts";
import { resolveToolPath } from "./payload.ts";
import { workspaceOf } from "./python.ts";

export const TRIAGE_TOOL = "foreman_triage";
export const GATED_TOOLS = new Set(["write", "edit", "foreman_move", "foreman_copy"]);
const RANK: Record<Tier, number> = { trivial: 0, standard: 1, heavy: 2 };

/** A tier counts as triaged once the foreman, the user or a ledger header recorded one (a later escalation keeps it). */
export function isTriaged(c: CeremonyState): boolean {
  return c.triaged === true || c.source === "foreman" || c.source === "user" || c.source === "ledger";
}

/** `foreman_triage`: record a tier. Never lowers a recorded or escalated tier. */
export function foremanTriage(c: CeremonyState, tier: Tier, reason: string): { state: CeremonyState } | { error: string } {
  if (c.source !== "default" && RANK[tier] < RANK[c.tier]) {
    return { error: `pi-foreman: the tier is already ${c.tier} (${c.source === "auto" ? "escalated automatically" : `recorded by ${c.source === "ledger" ? "the ledger header" : c.source === "user" ? "the user" : "the foreman"}`}); foreman_triage never lowers a recorded or escalated tier. Go on at ${c.tier}, or ask the owner, who can set the tier with /ceremony.` };
  }
  return { state: { ...c, tier, source: "foreman", reasons: [...c.reasons, `foreman triage ${tier}: ${reason}`], triaged: true } };
}

/** Tier rules appended to every `foreman_triage` answer (instructions/foreman.md Triage states the same). */
export const TRIAGE_RULES = "Tier rules: a version or hash bump is trivial; security hardening inside one component is standard, not heavy; at standard you may skip the explorer when your builder brief lists the files and symbols itself.";

/** What the foreman may do next at this tier (the tool's answer). */
export function triageAdvice(tier: Tier): string {
  return tier === "trivial"
    ? "You may make this small change yourself; at most one short explorer launch."
    : `Write the ledger .workflow/LEDGER-<topic>.md with the line \`Tier: ${tier}\` first, then delegate workspace edits to a builder; you do not edit workspace files yourself at this tier.`;
}

/** The answer at trivial on the builder path (trivial.ts). */
export function trivialPathAdvice(bounded: boolean): string {
  return `Write the ledger with the line \`Tier: trivial\` (no V item), then ${bounded ? "make the change yourself within ceremony.trivialBound, or " : ""}launch one builder on its default model; no explorer, planner, reviewer or finalizer. At finish the harness checks the diff: one source file within ceremony.trivialBound, no exported signature or schema change, no test file touched, a test present. Otherwise the tier becomes standard and a reviewer must pass.`;
}

/** `\\?\C:\x` ->`C:\x` (Win32 verbatim prefix); `\\?\UNC\...` is left as is. */
export function stripVerbatim(p: string): string {
  return /^\\\\\?\\(?!UNC\\)/i.test(p) ? p.slice(4) : p;
}

/** The OS's own resolution (expands Windows 8.3 short names), else the JS one. */
function realpath(p: string): string {
  try {
    return stripVerbatim(fs.realpathSync.native(p));
  } catch {
    return stripVerbatim(fs.realpathSync(p));
  }
}

/** Symlinks and short names resolved; a missing tail is kept below its nearest existing ancestor. */
export function realDeep(abs: string): string {
  const tail: string[] = [];
  let cur = stripVerbatim(abs);
  for (let n = 0; n < 128; n++) {
    try {
      const real = realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

export function under(root: string, p: string, platform: string): boolean {
  const fold = platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const rel = path.relative(fold(root), fold(p));
  const outside = rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || path.isAbsolute(rel);
  return rel === "" || !outside;
}

/** The paths a gated tool changes. */
export function changedPaths(toolName: string, input: Record<string, unknown>): unknown[] {
  if (toolName === "foreman_move") return [input.src, input.dst];
  if (toolName === "foreman_copy") return [input.dst];
  return [input.path, input.file_path, input.filePath].filter((v) => v !== undefined);
}

/**
 * The real `.workflow` folders that stay writable: the root's, plus the one of each directory
 * from the (real) cwd up to the root, so a foreman started in a subdirectory can write the
 * cwd-relative ledger the core points it to.
 */
export function workflowDirs(realCwd: string, realRoot: string, platform: string): string[] {
  const dirs = [path.join(realRoot, ".workflow")];
  if (!under(realRoot, realCwd, platform)) return dirs;
  for (let cur = realCwd, n = 0; n < 128 && cur !== realRoot && under(realRoot, cur, platform); n++) {
    dirs.push(path.join(cur, ".workflow"));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** The first changed path inside the workspace and outside the writable `.workflow/` folders, or null. */
export function workspaceTarget(toolName: string, input: Record<string, unknown>, cwd: string, home: string, platform: string): string | null {
  return workspaceTargets(toolName, input, cwd, home, platform)[0]?.raw ?? null;
}

/** Every changed path inside the workspace and outside the writable `.workflow/` folders: as given and resolved. */
export function workspaceTargets(toolName: string, input: Record<string, unknown>, cwd: string, home: string, platform: string): { raw: string; abs: string }[] {
  const out: { raw: string; abs: string }[] = [];
  const root = workspaceOf(cwd).root;
  const roots = [path.resolve(root), realDeep(path.resolve(root))];
  const workflows = workflowDirs(realDeep(path.resolve(cwd)), roots[1], platform);
  for (const raw of changedPaths(toolName, input)) {
    const abs = resolveToolPath(raw, cwd, home);
    if (!abs) continue;
    const real = realDeep(abs);
    if (!roots.some((r) => under(r, abs, platform) || under(r, real, platform))) continue;
    if (workflows.some((w) => under(w, real, platform) && real !== w)) continue;
    out.push({ raw: String(raw), abs });
  }
  return out;
}

/** Block reason for a foreman file-tool call, or undefined. */
export function triageGateBlock(toolName: string, input: Record<string, unknown>, c: CeremonyState, opts: { cwd: string; home: string; platform: string }): string | undefined {
  if (!GATED_TOOLS.has(toolName)) return undefined;
  const triaged = isTriaged(c);
  if (triaged && c.tier === "trivial") return undefined;
  const target = workspaceTarget(toolName, input, opts.cwd, opts.home, opts.platform);
  if (target === null) return undefined;
  if (!triaged) {
    return `pi-foreman: ${toolName} on '${target}' refused: no tier recorded yet (current: ${c.tier}, ${c.source === "auto" ? "escalated by a signal" : "config default"}). Call ${TRIAGE_TOOL}({tier, reason}) first. For trivial you may then make the change yourself; for standard or heavy write the ledger and launch a builder. Writes under .workflow/ stay open.`;
  }
  return `pi-foreman: ${toolName} on '${target}' refused: the tier is ${c.tier}, and at standard and heavy the foreman does not change workspace files itself. Launch a builder with the ledger item instead. Writes under .workflow/ (ledger, notes) stay open.`;
}
