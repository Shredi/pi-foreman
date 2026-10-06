// Precondition-checked operations (design §5): Pi tools that run scripts/safe_ops.py.
// The script re-checks every precondition right before it acts; when one fails, nothing changes
// and the tool reports `precondition failed: <which>`. A missing Python, a timeout, a crash or
// unreadable output is a tool error, and nothing is done either.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asciiJson } from "./payload.ts";
import type { Spawner } from "./spawn.ts";

export const SAFE_OP_TIMEOUT_MS = 120_000;

export type SafeOp = "move" | "copy" | "worktree_remove";

export type SafeOpOutcome =
  | { kind: "ran"; result: Record<string, unknown> }
  | { kind: "precondition"; precondition: string; message: string }
  | { kind: "error"; message: string };

export interface RunSafeOpInput {
  python: string | null;
  script: string;
  op: SafeOp;
  args: Record<string, unknown>;
  cwd: string;
  /** The merged `safety.ops` object. */
  config: unknown;
  env: Record<string, string>;
  spawner: Spawner;
  timeoutMs?: number;
}

export async function runSafeOp(input: RunSafeOpInput): Promise<SafeOpOutcome> {
  if (!input.python) return { kind: "error", message: "no Python >= 3.9 found; nothing was done. Set python.path or PI_FOREMAN_PYTHON and run /foreman doctor." };
  const timeoutMs = input.timeoutMs ?? SAFE_OP_TIMEOUT_MS;
  const r = await input.spawner(input.python, ["-E", "-s", input.script], {
    input: asciiJson({ op: input.op, args: input.args, cwd: input.cwd, config: input.config ?? {} }),
    env: input.env,
    cwd: input.cwd,
    timeoutMs,
  });
  if (r.error) return { kind: "error", message: `safe_ops.py could not start (${r.error.message}); nothing was done.` };
  if (r.timedOut) return { kind: "error", message: `safe_ops.py gave no answer within ${timeoutMs / 1000} s; the state is unknown, check it before retrying.` };
  let out: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out = parsed as Record<string, unknown>;
  } catch {
    out = null;
  }
  if (r.code !== 0 || !out) return { kind: "error", message: `safe_ops.py failed (exit ${r.code}): ${r.stderr.trim().slice(-400) || "no output"}` };
  if (out.ok === true) return { kind: "ran", result: out };
  const message = typeof out.message === "string" ? out.message : "safe_ops.py refused";
  if (typeof out.precondition === "string") return { kind: "precondition", precondition: out.precondition, message };
  return { kind: "error", message };
}

const PATH_PROP = (description: string) => ({ type: "string", minLength: 1, description });

/** Tool table. `foremanOnly` tools are not registered in children and refuse there. */
export const SAFE_OP_TOOLS: { name: string; op: SafeOp; label: string; description: string; parameters: Record<string, unknown>; foremanOnly: boolean }[] = [
  {
    name: "foreman_move",
    op: "move",
    label: "Move (checked)",
    description:
      "Move or rename a file or directory inside the workspace without approval. Runs only when source and destination resolve inside the git workspace root, the destination does not exist, neither is inside .git, and a tracked source is clean; uses `git mv` for tracked paths. Otherwise it changes nothing and returns `precondition failed: <which>`.",
    parameters: { type: "object", properties: { src: PATH_PROP("Source path, relative to the cwd or absolute."), dst: PATH_PROP("Destination path; must not exist.") }, required: ["src", "dst"], additionalProperties: false },
    foremanOnly: false,
  },
  {
    name: "foreman_copy",
    op: "copy",
    label: "Copy (checked)",
    description:
      "Copy a file or directory inside the workspace without approval and without overwriting. Runs only when both paths resolve inside the git workspace root, the destination does not exist, neither is inside .git, the source has no symlinks and is under safety.ops.copyMaxBytes. Otherwise it changes nothing and returns `precondition failed: <which>`.",
    parameters: { type: "object", properties: { src: PATH_PROP("Source file or directory."), dst: PATH_PROP("Destination path; must not exist.") }, required: ["src", "dst"], additionalProperties: false },
    foremanOnly: false,
  },
  {
    name: "foreman_worktree_remove",
    op: "worktree_remove",
    label: "Remove worktree (checked)",
    description:
      "Remove a linked git worktree and delete its branch with `git branch -d`, without approval. Runs only when the worktree is clean (no untracked files, no ignored files outside safety.ops.worktreeDisposable), its HEAD is merged into the base branch or contained in its pushed upstream, and no stash references its branch. Never forces. Otherwise it changes nothing and returns `precondition failed: <which>`.",
    parameters: { type: "object", properties: { path: PATH_PROP("Path of the linked worktree.") }, required: ["path"], additionalProperties: false },
    foremanOnly: true,
  },
];

export interface SafeOpsSession {
  python: string | null;
  isChild: boolean;
  /** The merged `safety.ops` object. */
  opsConfig: unknown;
  trace(rec: Record<string, unknown>): void;
}

export interface SafeOpsDeps {
  /** True when this process hosts a child session (tools marked foremanOnly are not registered). */
  isChild: boolean;
  session(ctx: ExtensionContext): Promise<SafeOpsSession>;
  script: string;
  spawner: Spawner;
  env(): Record<string, string>;
  timeoutMs?: number;
  /** Runs before the script (foreman git-config drift check); a block refuses the op. */
  preflight?(ctx: ExtensionContext, op: SafeOp, callId: string): Promise<{ block: true; reason: string } | undefined>;
}

export function registerSafeOps(pi: Pick<ExtensionAPI, "registerTool">, deps: SafeOpsDeps): string[] {
  const names: string[] = [];
  for (const t of SAFE_OP_TOOLS) {
    if (t.foremanOnly && deps.isChild) continue;
    names.push(t.name);
    pi.registerTool({
      name: t.name,
      label: t.label,
      description: t.description,
      // Plain JSON Schema: Pi validates schemas without the TypeBox marker the same way.
      parameters: t.parameters as never,
      async execute(id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        let s: SafeOpsSession;
        try {
          s = await deps.session(ctx);
        } catch (err) {
          return failure(`${t.name}: adapter error (${(err as Error).message}); nothing was done.`, { decision: "error" });
        }
        if (t.foremanOnly && s.isChild) {
          s.trace({ event: "safe_op", toolFamily: t.op, decision: "error" });
          return failure(`${t.name} is for the foreman only; nothing was done.`, { decision: "error" });
        }
        const pre = deps.preflight ? await deps.preflight(ctx, t.op, id) : undefined;
        if (pre) {
          s.trace({ event: "safe_op", toolFamily: t.op, decision: "blocked" });
          return failure(`${t.name}: ${pre.reason} Nothing was done.`, { decision: "blocked" });
        }
        const outcome = await runSafeOp({ python: s.python, script: deps.script, op: t.op, args: params, cwd: ctx.cwd, config: s.opsConfig, env: deps.env(), spawner: deps.spawner, timeoutMs: deps.timeoutMs });
        if (outcome.kind === "ran") {
          s.trace({ event: "safe_op", toolFamily: t.op, decision: "ran" });
          return { content: [{ type: "text" as const, text: `${t.name}: done. ${summary(outcome.result)}` }], details: { decision: "ran", result: outcome.result } };
        }
        if (outcome.kind === "precondition") {
          s.trace({ event: "safe_op", toolFamily: t.op, decision: "precondition_failed", precondition: outcome.precondition });
          return failure(`${t.name}: ${outcome.message}. Nothing was changed; the normal tools (with approval) remain available.`, { decision: "precondition_failed", precondition: outcome.precondition });
        }
        s.trace({ event: "safe_op", toolFamily: t.op, decision: "error" });
        return failure(`${t.name}: ${outcome.message}`, { decision: "error" });
      },
    } as never);
  }
  return names;
}

function failure(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}

function summary(r: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["action", "src", "dst", "path", "branch", "branchDeleted", "branchMessage", "bytes", "files"]) {
    if (r[k] !== undefined && r[k] !== null) parts.push(`${k}=${typeof r[k] === "string" ? r[k] : JSON.stringify(r[k])}`);
  }
  return parts.join(" ");
}
