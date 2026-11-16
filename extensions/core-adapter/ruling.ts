// Ruling files (R6 lane 4): `ruling-<n>.md` / `ruling.md` next to an `ask.md` in a handoff dir.
// Pure file-state helpers: a ruling older than its ask is ignored. A parent ruling never satisfies the finish gate (the chair runs
// /ceremony); after a FAIL the refusal only names it.
import * as fs from "node:fs";
import * as path from "node:path";
import { shellWrites } from "./permoverlay.ts";
import type { Decision } from "./permoverlay.ts";
import { isRulingName, RULING_RE } from "./rulingname.ts";

export { isRulingName };

const BRIEF_RE = /^brief-[A-Za-z0-9._-]{1,64}\.md$/;

/** True for a `brief-<x>.md` file name (a parent's brief to the session; the answer to a child's `ask.md`). */
export const isBriefName = (name: string): boolean => BRIEF_RE.test(name);

/** A name for self-write tracking and refusals: `isRulingName` and `brief-<x>.md` (it lifts the caps, index.ts capsReset). */
export const isTrackedRulingName = (name: string): boolean => isRulingName(name) || isBriefName(name);

/** A parent file that lifts the review cap and the read budgets: `brief-<x>.md`; never `ruling-<n>.md`, `ruling.md`, `ruling-plan.md`, `brief.md`. */
export const isCapsResetName = (name: string): boolean => isBriefName(name);

const mtimeOf = (p: string): number | null => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

const readText = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** A ruling file the wait may wake on: not older than the `ask.md` beside it (no ask.md, or no mtime = fresh). */
export function rulingFresh(file: string, mtime: (p: string) => number | null = mtimeOf): boolean {
  if (!isRulingName(path.basename(file))) return true;
  const ask = mtime(path.join(path.dirname(file), "ask.md"));
  const ruling = mtime(file);
  return ask === null || ruling === null || ruling >= ask;
}

/**
 * A file in a handoff dir that answers a question: `brief-<x>.md`, or `ruling-<n>.md` from a parent on the old footer. Never `ruling.md`,
 * `ruling-plan.md` or `steer-<n>.md`, and not a `brief-<x>.md` whose bytes equal the `ruling.md` or `ruling-plan.md` beside it (locally a plan
 * ruling travels as such a copy).
 */
export function isAnswerFile(dir: string, name: string): boolean {
  const n = RULING_RE.exec(name)?.[1];
  if (n !== undefined) return Number(n) >= 1;
  if (!isBriefName(name)) return false;
  const bytes = (p: string): Buffer | null => {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  };
  const brief = bytes(path.join(dir, name));
  if (!brief) return false;
  return !PLAN_RULING_NAMES.some((r) => bytes(path.join(dir, r))?.equals(brief));
}

const PLAN_RULING_NAMES = ["ruling.md", "ruling-plan.md"];

/** `dir` holds an answer file (`isAnswerFile`) modified after `sinceMs` (`orAt`: or at `sinceMs`, so an equal mtime counts). */
export function answerNewerThan(dir: string, sinceMs: number, orAt = false): boolean {
  try {
    return fs.readdirSync(dir).some((name) => {
      const m = mtimeOf(path.join(dir, name));
      return m !== null && (orAt ? m >= sinceMs : m > sinceMs) && isAnswerFile(dir, name);
    });
  } catch {
    return false;
  }
}

const realKey = (p: string): string => {
  try {
    return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
  } catch {
    return path.resolve(p);
  }
};

/** The ruling files in `dirs` with their mtimes (a snapshot before a shell command). */
export function snapshotRulings(dirs: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const dir of dirs) {
    try {
      for (const n of fs.readdirSync(dir).filter(isTrackedRulingName)) {
        const m = mtimeOf(path.join(dir, n));
        if (m !== null) out.set(path.join(dir, n), m);
      }
    } catch {
      // no dir
    }
  }
  return out;
}

/**
 * Ruling files this session wrote itself (write/edit, or a shell command that changed them). They never count as a
 * parent ruling: the foreman can write its own handoff dir, and a self-written APPROVED is no parent verdict. A file
 * is ignored while its mtime is not newer than the recorded write; a later parent write counts again.
 */
export class SelfRulings {
  private readonly written = new Map<string, number>();

  /** A write/edit of `file`: remember its mtime (only ruling names). */
  mark(file: string): void {
    if (!isTrackedRulingName(path.basename(file))) return;
    const m = mtimeOf(file);
    if (m !== null) this.written.set(realKey(file), m);
  }

  /** After a shell command: every ruling file in `dirs` new or changed since `before` was written by this session. */
  markChanged(before: Map<string, number>, dirs: string[]): void {
    for (const [f, m] of snapshotRulings(dirs)) if (before.get(f) !== m) this.written.set(realKey(f), m);
  }

  /** True when `file` (at `mtime`) is a ruling this session wrote. */
  has(file: string, mtime: number): boolean {
    const w = this.written.get(realKey(file));
    return w !== undefined && mtime <= w;
  }
}

/**
 * A parent ruling in `dirs` (`ruling.md` / `ruling-<n>.md`, first line `APPROVED` or `SHIP`) whose mtime is newer than
 * `afterMs` (the last FAIL verdict). Returns its path, or null. Only for naming it in the finish refusal: it is never a
 * verdict. `dirs` must be the dirs where this session is the child (owned.ts childHandoffDirs); `self` skips rulings
 * this session wrote.
 */
export function parentApproval(dirs: string[], afterMs: number, self?: SelfRulings): string | null {
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(isRulingName);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = mtimeOf(path.join(dir, n));
      if (m === null || m <= afterMs || self?.has(path.join(dir, n), m)) continue;
      const first = (readText(path.join(dir, n)) ?? "").split(/\r?\n/, 1)[0].trim();
      if (first === "APPROVED" || first === "SHIP") return path.join(dir, n);
    }
  }
  return null;
}

/** The refusal reason when a session writes a ruling file in a dir where it is the child. */
export const SELF_RULING_REASON = "a session cannot write its own parent's ruling";

const realDir = (d: string): string => path.dirname(realKey(path.join(d, "x")));
const SHELL_TOOLS = new Set(["bash", "powershell", "foreman_bg", "bg_run"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const shellOf = (toolName: string): "posix" | "powershell" => (toolName === "powershell" ? "powershell" : "posix");

/**
 * Refusal reason when `toolName` writes a `ruling*.md` or `brief-*.md` inside one of `childDirs` (the dirs where this session is the child) at a
 * literal path, else undefined: write/edit `path`, foreman_copy/foreman_move `dst`, or a write surface of a shell line
 * (permoverlay.ts shellWrites), resolved against `cwd` as written. R16 item 4a: no cd, variable or symlink tracking, no suffix
 * joins; what the literal path does not show is selfRulingAsk's. `*.ack` files are never ruling names; a copy source is a read.
 */
export function selfRulingRefusal(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[]): string | undefined {
  if (childDirs.length === 0) return undefined;
  const dirs = new Set(childDirs.map(realDir));
  const inChild = (p: string): boolean => isTrackedRulingName(path.basename(p)) && dirs.has(path.dirname(realKey(path.resolve(cwd, p))));
  const words = toolName === "write" || toolName === "edit" ? [str(input.path)] : toolName === "foreman_copy" || toolName === "foreman_move" ? [str(input.dst)] : [];
  const cmd = SHELL_TOOLS.has(toolName) ? str(input.command) : null;
  if (cmd) words.push(...shellWrites(cmd, shellOf(toolName)).words);
  return words.some((p) => p && inChild(p)) ? SELF_RULING_REASON : undefined;
}

/**
 * R16 item 4a (ruling D1): a FLAT ask trigger on the lexed line, no resolution. A shell line with a write surface anywhere
 * (shellWrites), the token `ruling` or `brief` anywhere and a handoff-dir path anywhere (one of `childDirs`, or `handoffs/<its name>` in any
 * spelling: `~`, `$HOME`, relative) is an overlay ask: the auto reviewer judges it under the rules' hard_deny, the human on defer.
 * A pure read of a ruling never asks; a dir where this session is the parent (its child's rulings) is no trigger.
 */
export function selfRulingAsk(toolName: string, input: Record<string, unknown>, childDirs: string[], lift?: { cwd: string; orchestrator: boolean }): Decision | undefined {
  const cmd = SHELL_TOOLS.has(toolName) ? str(input.command) : null;
  if (!cmd || childDirs.length === 0 || !/ruling|brief/i.test(cmd)) return undefined;
  const fold = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
  const line = fold(cmd);
  if (!childDirs.some((d) => [`handoffs/${path.basename(d)}`, d, realDir(d)].some((p) => line.includes(fold(p))))) return undefined;
  // R31c R6: an orchestrator's own heredoc into a child-role file of its own handoff dir (the body may say "ruling")
  if (lift?.orchestrator && ownHandoffHeredoc(toolName, cmd, childDirs, lift.cwd)) return undefined;
  const w = shellWrites(cmd, shellOf(toolName));
  if (w.words.length === 0 && !w.unnamed) return undefined;
  return { kind: "ask", reason: "pi-foreman: this line writes, names a ruling and a handoff dir; a session never writes its own parent's ruling, so it needs approval.", rule: "self-ruling" };
}

/** The handoff files a session writes in a dir where it is the child (the child-role names; a broader pattern for another purpose, not the shell guard's allow-list `HANDOFF_CHILD_NAMES` in pathrules.ts; `ruling*`, `brief*`, `steer*`, `parent` and `child` are never among them). */
const CHILD_ROLE_NAME = /^(?:plan|result)\.md$|^(?:update|ask)[A-Za-z0-9_-]*\.md$/;
const HEREDOC_TARGET = "[A-Za-z0-9._/@%+,-][A-Za-z0-9._/@%+=,-]*";
const HEREDOC_A = new RegExp(`^cat[ \\t]+(>>?)[ \\t]*(${HEREDOC_TARGET})[ \\t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \\t]*$`);
const HEREDOC_B = new RegExp(`^cat[ \\t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \\t]+(>>?)[ \\t]*(${HEREDOC_TARGET})[ \\t]*$`);

/**
 * R31c R6: the command is exactly one `cat > T <<'D'` / `cat >> T <<'D'` / `cat <<'D' > T` / `cat <<'D' >> T` heredoc (POSIX shell tools only) whose
 * body runs to the one terminator line `D`, which is the last line (one trailing newline allowed). The body is never lexed. `T` has no `..`,
 * lies directly in one of `childDirs` (the lexical parent is that dir, no symlinked spelling), is not a symlink, has a single link when it exists, and is
 * named like a child-role file (CHILD_ROLE_NAME).
 */
export function ownHandoffHeredoc(toolName: string, cmd: string, childDirs: string[], cwd: string): boolean {
  if (toolName === "powershell" || !SHELL_TOOLS.has(toolName) || /[\r\0]/.test(cmd)) return false;
  const lines = cmd.split("\n");
  const a = HEREDOC_A.exec(lines[0]);
  const b = a ? null : HEREDOC_B.exec(lines[0]);
  const target = a ? a[2] : b?.[3];
  const delim = a ? a[3] : b?.[1];
  if (!target || !delim) return false;
  const end = lines.indexOf(delim, 1);
  if (end < 0 || !(lines.length === end + 1 || (lines.length === end + 2 && lines[end + 1] === ""))) return false;
  if (target.split("/").includes("..") || !CHILD_ROLE_NAME.test(path.basename(target))) return false;
  const abs = path.resolve(cwd, target);
  const parent = path.dirname(abs);
  if (!childDirs.some((d) => [path.resolve(d), realDir(d)].includes(parent))) return false;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return true;
}

/** What `/foreman close` adds when the ceremony is incomplete: what the parent must still rule. */
export function rulingNeeded(missing: string[]): string {
  return missing.length === 0
    ? ""
    : `Missing: ${missing.join(", ")}. The parent must still rule on it; a ruling file never satisfies the finish gate, the owner/chair runs /ceremony <tier>.`;
}

/** Refusal addendum when a parent ruling file is newer than the last FAIL verdict: it is named, and does not lift the gate. */
export function rulingOverrideNote(ruling: string, failAt: number): string {
  return ` A parent ruling ${ruling} is newer than the last FAIL verdict (${new Date(failAt).toISOString()}), but a parent ruling never satisfies the finish gate; the owner/chair runs: /ceremony <tier>`;
}
