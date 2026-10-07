// Plan checkpoint (heavy tier): the owner approves a plan file before any builder launches.
// `foreman_checkpoint(path)` records the latest checkpoint of the session (in memory, like the
// review verdicts); a builder launch at tier heavy is refused unless that record is approved and
// the file still hashes the same. The hash is sha256 over the bytes the harness reads itself; the
// model never supplies one. Same bytes after a delete and re-create = same hash = still approved.
//
// Path rules (the edit mode's own helpers): inside the foreman's workspace, directly in the real
// scratch dir (ceremony.scratchDir), basename `plan-<topic>.md` with topic [A-Za-z0-9._-]{1,64},
// a regular file, no symlink in any component, one hard link, at most 256 KiB.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { scratchRoot } from "./editmode.ts";
import { resolveToolPath } from "./payload.ts";
import { workspaceOf } from "./python.ts";
import { realDeep, under } from "./triage.ts";

export const CHECKPOINT_TOOL = "foreman_checkpoint";
export const PLAN_MAX_BYTES = 256 * 1024;
export const PLAN_NAME = /^plan-([A-Za-z0-9._-]{1,64})\.md$/;
export const CHECKPOINT_CHOICES = ["approve", "revise", "reject"] as const;

export type PlanStatus = "pending" | "approved" | "revise" | "rejected";
export type LaunchRefusal = "plan_required" | "checkpoint_pending" | "plan_changed";

/** The session's latest checkpoint. */
export interface PlanRecord {
  topic: string;
  /** Real absolute path of the plan file. */
  path: string;
  hash: string;
  status: PlanStatus;
  approvedAt: string | null;
  by: "user" | "rig" | null;
  note?: string;
}

export interface PlanFile {
  topic: string;
  /** Real absolute path. */
  path: string;
  /** Workspace-relative path, `/`-separated (for messages). */
  rel: string;
  bytes: Buffer;
  hash: string;
}

export interface PlanOpts {
  cwd: string;
  home: string;
  platform: string;
  scratchDir: string;
}

const fold = (platform: string) => (platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s);

export function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function refused(why: string, scratchDir: string): { error: string } {
  return { error: `pi-foreman: ${CHECKPOINT_TOOL} refused: ${why}. Write the plan as ${scratchDir}/plan-<topic>.md (topic: letters, digits, . _ -, at most 64; a regular file, no symlink or hard link, at most 256 KiB) and call ${CHECKPOINT_TOOL} with that path.` };
}

/** Validate a plan path and read the file; the record's hash comes from these bytes. */
export function readPlan(raw: unknown, o: PlanOpts): { plan: PlanFile } | { error: string } {
  const f = fold(o.platform);
  const abs = resolveToolPath(raw, o.cwd, o.home);
  if (!abs) return refused("path must be a non-empty string", o.scratchDir);
  const lexRoot = path.resolve(workspaceOf(o.cwd).root);
  const realRoot = realDeep(lexRoot);
  const root = [realRoot, lexRoot].find((r) => under(r, abs, o.platform));
  if (!root) return refused("the path is outside the workspace", o.scratchDir);
  // The same path below the real root: any symlink component makes its real path differ.
  const candidate = path.join(realRoot, path.relative(f(root), f(abs)));
  const real = realDeep(candidate);
  if (f(real) !== f(candidate)) return refused("the path passes through a symlink", o.scratchDir);
  const scratch = scratchRoot(realRoot, o.scratchDir, o.platform);
  if (!scratch) return refused(`the scratch dir ${o.scratchDir} is disabled`, o.scratchDir);
  if (f(path.dirname(real)) !== f(scratch)) return refused(`the plan must be directly in ${o.scratchDir}`, o.scratchDir);
  const m = PLAN_NAME.exec(path.basename(real));
  if (!m) return refused("the file name must be plan-<topic>.md", o.scratchDir);
  let fd: number;
  try {
    const st = fs.lstatSync(real);
    if (!st.isFile()) return refused("not a regular file", o.scratchDir);
    if (st.nlink !== 1) return refused("the file has more than one hard link", o.scratchDir);
    if (st.size > PLAN_MAX_BYTES) return refused("the file is larger than 256 KiB", o.scratchDir);
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return refused("the file does not exist or cannot be read", o.scratchDir);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > PLAN_MAX_BYTES) return refused("the file changed while it was read", o.scratchDir);
    const bytes = fs.readFileSync(fd);
    if (bytes.length > PLAN_MAX_BYTES) return refused("the file is larger than 256 KiB", o.scratchDir);
    const rel = path.relative(realRoot, real).split(path.sep).join("/");
    return { plan: { topic: m[1], path: real, rel, bytes, hash: sha256(bytes) } };
  } catch {
    return refused("the file cannot be read", o.scratchDir);
  } finally {
    fs.closeSync(fd);
  }
}

/** Hash of the recorded plan file now, or null when it is gone or no longer passes the path rules. */
export function currentPlanHash(rec: PlanRecord, o: PlanOpts): string | null {
  const r = readPlan(rec.path, o);
  return "plan" in r ? r.plan.hash : null;
}

/** True when `raw` names a `plan-<topic>.md` directly in the real scratch dir (file need not exist). */
export function isPlanPath(raw: unknown, o: PlanOpts): boolean {
  const abs = resolveToolPath(raw, o.cwd, o.home);
  if (!abs) return false;
  const realRoot = realDeep(path.resolve(workspaceOf(o.cwd).root));
  const scratch = scratchRoot(realRoot, o.scratchDir, o.platform);
  if (!scratch) return false;
  const real = realDeep(abs);
  return fold(o.platform)(path.dirname(real)) === fold(o.platform)(scratch) && PLAN_NAME.test(path.basename(real));
}

/** name -> sha256 of every regular `plan-*.md` directly in the real scratch dir (planner run-end comparison). */
export function planSnapshot(o: Omit<PlanOpts, "home">): Map<string, string> {
  const out = new Map<string, string>();
  const scratch = scratchRoot(realDeep(path.resolve(workspaceOf(o.cwd).root)), o.scratchDir, o.platform);
  if (!scratch) return out;
  let names: string[];
  try {
    names = fs.readdirSync(scratch);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!PLAN_NAME.test(name)) continue;
    try {
      const p = path.join(scratch, name);
      const st = fs.lstatSync(p);
      if (st.isFile() && st.size <= PLAN_MAX_BYTES) out.set(name, sha256(fs.readFileSync(p)));
    } catch {
      // gone between readdir and read
    }
  }
  return out;
}

/** Plan files new or changed between two snapshots. */
export function changedPlans(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name);
}

/** Why a builder launch is refused at this tier, or null. `currentHash` null = file gone or no longer valid. */
export function builderLaunchRefusal(rec: PlanRecord | null | undefined, tier: string, currentHash: string | null): LaunchRefusal | null {
  if (tier !== "heavy") return null;
  if (!rec || rec.status === "rejected") return "plan_required";
  if (rec.status !== "approved") return "checkpoint_pending";
  return currentHash === rec.hash ? null : "plan_changed";
}

/** The refusal text for a builder launch. */
export function launchRefusalText(reason: LaunchRefusal, rec: PlanRecord | null | undefined, scratchDir: string): string {
  const head = `pi-foreman: builder launch refused [launch_refused:${reason}]:`;
  const name = rec ? `plan-${rec.topic}.md` : "";
  if (reason === "plan_required" && rec?.status === "rejected") return `${head} the owner rejected ${name}, so the heavy path is stopped. Launch no builder; report to the owner and ask how to go on. A new plan needs a new ${CHECKPOINT_TOOL} approval.`;
  if (reason === "plan_required") return `${head} at tier heavy a builder starts only after the owner approved a plan. Write ${scratchDir}/plan-<topic>.md (or launch the planner), then call ${CHECKPOINT_TOOL} with its path and wait for the owner's answer.`;
  if (reason === "checkpoint_pending") return `${head} the checkpoint of ${name} is ${rec?.status === "revise" ? "waiting for a revised plan" : "pending (no answer from the owner yet)"}. ${rec?.status === "revise" ? `Change the plan as the owner asked, then call ${CHECKPOINT_TOOL} again.` : `Ask the owner in your reply, or call ${CHECKPOINT_TOOL} again with the same path.`}`;
  return `${head} ${name} changed or is gone since the owner approved it. Call ${CHECKPOINT_TOOL} again so the owner approves the current version.`;
}

const clean = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim().slice(0, 200);

/** What the owner sees before the dialog: title, Goal's first lines, section headings, path, hash prefix (at most 12 lines). */
export function planSummary(text: string, rel: string, hash: string): string {
  const lines = text.split(/\r?\n/);
  const heading = /^(#{1,6})\s+(.*)$/;
  const title = lines.map((l) => heading.exec(l)).find((h) => h && h[1] === "#")?.[2] ?? lines.find((l) => l.trim()) ?? "(untitled)";
  const sections = lines.map((l) => heading.exec(l)).filter((h): h is RegExpExecArray => !!h && h[1].length > 1).map((h) => clean(h[2]));
  const goalAt = lines.findIndex((l) => { const h = heading.exec(l); return !!h && /^goal\b/i.test(h[2].trim()); });
  const goal: string[] = [];
  if (goalAt >= 0) {
    for (const l of lines.slice(goalAt + 1)) {
      if (heading.test(l)) break;
      if (l.trim()) goal.push(clean(l));
      if (goal.length === 4) break;
    }
  }
  const out = [`Plan: ${clean(title)}`, ...goal.map((g, i) => (i === 0 ? `Goal: ${g}` : `  ${g}`)), `Sections: ${sections.join(" · ").slice(0, 200) || "(none)"}`, `File: ${rel}`, `sha256: ${hash.slice(0, 12)}`];
  return out.slice(0, 12).join("\n");
}
