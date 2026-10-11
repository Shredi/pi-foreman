// Optional git tool pack (docs/tools.md): four capped, read-only git tools that run the read ops
// of scripts/safe_ops.py. Registered always with defaultActive false; the foreman activates them
// when tools.git is true, a child keeps them only when the foreman said so (PI_FOREMAN_TOOL_PACKS)
// and its own config agrees.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { get } from "./config.ts";
import type { Env } from "./env.ts";
import { runSafeOp } from "./safeops.ts";
import type { Spawner } from "./spawn.ts";

export const GIT_PACK = "git";
export const PACK_ENV = "PI_FOREMAN_TOOL_PACKS";
export type GitReadOp = "status" | "log" | "diff_stat" | "branch_state";

const str = (max: number, description: string) => ({ type: "string", minLength: 1, maxLength: max, description });
const CAPS = "At most 200 entries and 16 KB; `truncated` and `total` say when the list was cut. Bash git still works.";

export const GIT_PACK_TOOLS: { name: string; op: GitReadOp; label: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "git_status",
    op: "status",
    label: "Git status",
    description: `Structured git status of the workspace: branch, head, upstream, ahead/behind, counts (staged, unstaged, untracked, conflicted) and the changed files. Read-only. ${CAPS}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "git_log",
    op: "log",
    label: "Git log",
    description: `Recent commits (sha, short, date, author, subject), newest first, optionally of one revision or path. Read-only. Default 20, at most 200. ${CAPS}`,
    parameters: {
      type: "object",
      properties: {
        n: { type: "integer", minimum: 1, maximum: 200, description: "Number of commits (default 20)." },
        rev: str(200, "Revision or range of plain ref characters (default HEAD); no ':' or '{'."),
        path: str(1024, "Limit to one path inside the workspace."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_diff_stat",
    op: "diff_stat",
    label: "Git diff stat",
    description: `Per-file added and deleted line counts of the working tree against HEAD, or of a revision range. Read-only, no diff text. ${CAPS}`,
    parameters: {
      type: "object",
      properties: { range: str(200, "Revision or range such as HEAD~1..HEAD (default: working tree against HEAD)."), path: str(1024, "Limit to one path inside the workspace.") },
      additionalProperties: false,
    },
  },
  {
    name: "git_branch_state",
    op: "branch_state",
    label: "Git branch state",
    description: `State of a local branch (default the current one): head, upstream with ahead/behind, and whether it is merged into the base branch. Read-only. ${CAPS}`,
    parameters: { type: "object", properties: { branch: str(200, "Local branch name (default the current branch).") }, additionalProperties: false },
  },
];

export const GIT_PACK_TOOL_NAMES: readonly string[] = GIT_PACK_TOOLS.map((t) => t.name);

export function envNamesPack(env: Env, pack: string = GIT_PACK): boolean {
  return (env[PACK_ENV] ?? "").split(",").some((x) => x.trim() === pack);
}

export function gitPackOn(i: { config: unknown; isChild: boolean; env: Env }): boolean {
  return get(i.config, "tools.git") === true && (!i.isChild || envNamesPack(i.env));
}

export function applyGitPack(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, on: boolean, isChild: boolean, env: Env): void {
  const active = pi.getActiveTools();
  if (isChild) {
    if (!on && active.some((n) => GIT_PACK_TOOL_NAMES.includes(n))) pi.setActiveTools(active.filter((n) => !GIT_PACK_TOOL_NAMES.includes(n)));
    return;
  }
  if (!on) {
    delete env[PACK_ENV];
    return;
  }
  const missing = GIT_PACK_TOOL_NAMES.filter((n) => !active.includes(n));
  if (missing.length) pi.setActiveTools([...active, ...missing]);
  env[PACK_ENV] = GIT_PACK;
}

export interface GitPackSession {
  python: string | null;
  isChild: boolean;
  packOn: boolean;
  /** The merged `safety.ops` object. */
  opsConfig: unknown;
  trace(rec: Record<string, unknown>): void;
}

export interface GitPackDeps {
  session(ctx: ExtensionContext): Promise<GitPackSession>;
  script: string;
  spawner: Spawner;
  env(): Record<string, string>;
  timeoutMs?: number;
  /** Runs before the script (foreman git-config drift check); a block refuses the op. */
  preflight?(ctx: ExtensionContext, op: GitReadOp, callId: string): Promise<{ block: true; reason: string } | undefined>;
}

function failure(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}

export function registerGitPack(pi: Pick<ExtensionAPI, "registerTool">, deps: GitPackDeps): string[] {
  const names: string[] = [];
  for (const t of GIT_PACK_TOOLS) {
    names.push(t.name);
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters as never,
      defaultActive: false,
      async execute(id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        let s: GitPackSession;
        try {
          s = await deps.session(ctx);
        } catch (err) {
          return failure(`${t.name}: adapter error (${(err as Error).message}); nothing was done.`, { decision: "error" });
        }
        if (!s.packOn) return failure(`${t.name}: the git tool pack is off (tools.git); use bash git. Nothing was done.`, { decision: "pack_off" });
        s.trace({ event: "tool_pack", pack: GIT_PACK, op: t.op });
        const pre = deps.preflight ? await deps.preflight(ctx, t.op, id) : undefined;
        if (pre) return failure(`${t.name}: ${pre.reason} Nothing was done.`, { decision: "blocked" });
        const outcome = await runSafeOp({ python: s.python, script: deps.script, op: t.op, args: params, cwd: ctx.cwd, config: s.opsConfig, env: deps.env(), spawner: deps.spawner, timeoutMs: deps.timeoutMs });
        if (outcome.kind === "ran") {
          const { ok: _ok, ...rest } = outcome.result;
          return { content: [{ type: "text" as const, text: `${t.name}: ${JSON.stringify(rest)}` }], details: { decision: "ran", result: outcome.result } };
        }
        if (outcome.kind === "precondition") return failure(`${t.name}: ${outcome.message}. Nothing was changed.`, { decision: "precondition_failed", precondition: outcome.precondition });
        return failure(`${t.name}: ${outcome.message}`, { decision: "error" });
      },
    } as never);
  }
  return names;
}
