// Triage enforced (plan D10): the foreman records a tier before it changes workspace files
// itself, and only a trivial task lets it do so. `foreman_triage` records the tier; the gate in
// the tool_call hook refuses write, edit, foreman_move (source and destination) and foreman_copy
// (destination) on paths inside the workspace while the tier is untriaged (config default or
// only escalated by a signal) or standard/heavy. `.workflow/**` (ledger, notes) stays writable.
//
// Paths: as given (resolveToolPath) and with symlinks resolved (deepest existing ancestor plus
// the missing tail), each checked against the workspace root as given and resolved. Either one
// inside counts, so a symlink cannot carry a write into the workspace. The `.workflow` exemption
// holds only when the resolved target is below the resolved root's real `.workflow` folder, so a
// link inside `.workflow` cannot carry a write out of it.
//
// LIMIT (documented, design/architecture.md): shell writes (redirects, `sed -i`, scripts) are not
// gated here; the OS boundary planned for Phase 4 covers them.
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

/** What the foreman may do next at this tier (the tool's answer). */
export function triageAdvice(tier: Tier): string {
  return tier === "trivial"
    ? "You may make this small change yourself; at most one short explorer launch."
    : `Write the ledger .workflow/LEDGER-<topic>.md with the line \`Tier: ${tier}\` first, then delegate workspace edits to a builder; you do not edit workspace files yourself at this tier.`;
}

function realDeep(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (let n = 0; n < 128; n++) {
    try {
      const real = fs.realpathSync(cur);
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

function under(root: string, p: string, platform: string): boolean {
  const fold = platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const rel = path.relative(fold(root), fold(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The paths a gated tool changes. */
export function changedPaths(toolName: string, input: Record<string, unknown>): unknown[] {
  if (toolName === "foreman_move") return [input.src, input.dst];
  if (toolName === "foreman_copy") return [input.dst];
  return [input.path, input.file_path, input.filePath].filter((v) => v !== undefined);
}

/** The first changed path inside the workspace and outside `.workflow/`, or null. */
export function workspaceTarget(toolName: string, input: Record<string, unknown>, cwd: string, home: string, platform: string): string | null {
  const root = workspaceOf(cwd).root;
  const roots = [path.resolve(root), realDeep(path.resolve(root))];
  const workflow = path.join(roots[1], ".workflow");
  for (const raw of changedPaths(toolName, input)) {
    const abs = resolveToolPath(raw, cwd, home);
    if (!abs) continue;
    const real = realDeep(abs);
    if (!roots.some((r) => under(r, abs, platform) || under(r, real, platform))) continue;
    if (under(workflow, real, platform) && real !== workflow) continue;
    return String(raw);
  }
  return null;
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
