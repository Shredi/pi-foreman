// Plan checkpoint (heavy tier): the owner approves a plan file before any builder launches.
// `foreman_checkpoint(path)` records the latest checkpoint of the session (in memory, like the
// review verdicts); a builder launch at tier heavy is refused unless that record is approved and
// the file still hashes the same. The hash is the plan VERSION (planVersionHash: sha256 of the body
// above any ruling/decision-log/addendum appendix, isAppendixLine) over the bytes the harness reads itself; the
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
import { parentApproval } from "./ruling.ts";
import type { SelfRulings } from "./ruling.ts";
import { workspaceOf } from "./python.ts";
import { realDeep, under } from "./triage.ts";

export const CHECKPOINT_TOOL = "foreman_checkpoint";
export const PLAN_MAX_BYTES = 256 * 1024;
export const PLAN_NAME = /^plan-([A-Za-z0-9._-]{1,64})\.md$/;
// approve last: never the preselected option, so a stray Enter does not approve.
export const CHECKPOINT_CHOICES = ["revise", "reject", "approve"] as const;

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
  /** Where the approval came from (planstate.ts persists it): the dialog, the parent's ruling-plan.md or ruling.md. */
  source?: "dialog" | "ruling-plan" | "ruling";
  note?: string;
}

export interface PlanFile {
  topic: string;
  /** Real absolute path. */
  path: string;
  /** Workspace-relative path, `/`-separated (for messages). */
  rel: string;
  bytes: Buffer;
  /** Version hash (planVersionHash): the body above any appendix. */
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

/**
 * Whether a line starts the appendix of a plan file (rulings, not the reviewed plan): a level 2 or 3 heading, case-insensitive,
 * whose text starts with Addendum, Addenda, Ruling, Rulings, Parent ruling or Decision log as a whole word (followed by the end of the
 * line, `:`, ` -`, ` (` or ` <digit>`), or the line `<!-- plan-appendix -->`. Trailing whitespace is ignored.
 */
export function isAppendixLine(line: string): boolean {
  const l = line.replace(/\s+$/, "");
  return l === "<!-- plan-appendix -->" || /^#{2,3}[ \t]+(?:addendum|addenda|rulings?|parent ruling|decision log)(?=$|:|[ \t]-|[ \t]\(|[ \t]\d)/i.test(l);
}

/** Start offset of the first appendix line in `text`, or -1 (no appendix). `text` must keep one char per byte (latin1) when used for offsets. */
function appendixOffset(text: string): number {
  let at = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (isAppendixLine(line)) return at;
    at += line.length;
  }
  return -1;
}

/**
 * The plan body: the bytes before the first appendix line. With an appendix, trailing whitespace of the
 * body is normalised to one newline, so appending `\n## Ruling ...` to a file that ended in a newline keeps
 * the body (and so the version) unchanged. With no appendix the body is the whole file.
 */
export function planBody(bytes: Buffer): Buffer {
  const at = appendixOffset(bytes.toString("latin1"));
  if (at < 0) return bytes;
  return Buffer.from(bytes.subarray(0, at).toString("latin1").replace(/\s+$/, "") + "\n", "latin1");
}

/**
 * Version hash of a plan: sha256 of the body (planBody). Rulings, decision logs and addenda appended below
 * an appendix heading are outside review and approval; a body edit is a new version. Equals sha256(bytes)
 * when the file has no appendix.
 */
export function planVersionHash(bytes: Buffer): string {
  return sha256(planBody(bytes));
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
  // The same path below the real root: any symlink component makes its real path differ. The
  // components come from the case-preserved path; case folding only decided containment above.
  const depth = path.relative(f(root), f(abs)).split(path.sep).filter(Boolean).length;
  const candidate = path.join(realRoot, ...(depth ? path.resolve(abs).split(path.sep).slice(-depth) : []));
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
    return { plan: { topic: m[1], path: real, rel, bytes, hash: planVersionHash(bytes) } };
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

/** The parent-written verdict file of the plan checkpoint, in the session's handoff dir. */
export const PLAN_VERDICT_FILE = "ruling-plan.md";
export type CheckpointMode = "parent" | "human";
export type PlanVerdict = { kind: "approve" } | { kind: "revise"; note: string } | { kind: "reject" };

/** `ceremony.checkpoint` when set, else `parent` for a session opened with a parent (handoff dir and parent intercom id in the env), else `human`. */
export function checkpointMode(configured: unknown, env: NodeJS.ProcessEnv): CheckpointMode {
  if (configured === "parent" || configured === "human") return configured;
  return env.PI_FOREMAN_HANDOFF_DIR?.trim() && env.PI_FOREMAN_PARENT_INTERCOM?.trim() ? "parent" : "human";
}

/**
 * The parent's verdict on the plan: first line `APPROVED`, `REVISE <text>` (the rest of the file joins the text) or `REJECT` in
 * `<dir>/ruling-plan.md`. A regular file whose ctime is newer than the plan file's ctime (neither can be set back, unlike an mtime): a plan edit after the
 * verdict makes it stale, so the edited plan needs a new one. Null = no usable verdict. Without a usable `ruling-plan.md`, the parent's
 * `ruling.md` (first line `APPROVED`, same ctime binding, not written by this session: `self`) approves too.
 */
export function readPlanVerdict(dir: string, planFile: string, self?: SelfRulings): PlanVerdict | null {
  const own = readPlanVerdictFile(dir, planFile, self);
  if (own) return own;
  try {
    return parentApproval([dir], fs.statSync(planFile).ctimeMs, self, true) ? { kind: "approve" } : null;
  } catch {
    return null;
  }
}

export function readPlanVerdictFile(dir: string, planFile: string, self?: SelfRulings): PlanVerdict | null {
  try {
    const file = path.join(dir, PLAN_VERDICT_FILE);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > PLAN_MAX_BYTES || st.ctimeMs <= fs.statSync(planFile).ctimeMs || self?.has(file, st.mtimeMs)) return null;
    const text = fs.readFileSync(file, "utf8");
    const first = text.split(/\r?\n/, 1)[0].trim();
    if (first === "APPROVED") return { kind: "approve" };
    if (first === "REJECT") return { kind: "reject" };
    if (/^REVISE(\s|$)/.test(first)) return { kind: "revise", note: (first.slice(6) + text.slice(text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"))).trim() };
    return null;
  } catch {
    return null;
  }
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
  const all = text.split(/\r?\n/);
  const cut = all.findIndex(isAppendixLine);
  const lines = cut < 0 ? all : all.slice(0, cut);
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
  const out = [`Plan: ${clean(title)}`, ...goal.map((g, i) => (i === 0 ? `Goal: ${g}` : `  ${g}`)), `Sections: ${sections.join(" · ").slice(0, 200) || "(none)"}`, ...(cut < 0 ? [] : [`Appendix: from "${clean(all[cut])}" (outside review and approval)`]), `File: ${rel}`, `sha256: ${hash.slice(0, 12)}`];
  return out.slice(0, 12).join("\n");
}
