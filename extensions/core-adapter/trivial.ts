// Trivial tier, builder path (frugal-roles D6, ledger items 9 and 21).
//
// trivial = one source file within `ceremony.trivialBound`, no exported signature or schema change,
// a test that covers the package (a test file in the source file's directory or below it, or a
// project test command), and no test file touched. The tier is the foreman's triage; the harness
// does not trust it: at finish, a trivial session that launched a builder has its work diff
// scanned (diffscan.ts, base = HEAD at the first builder launch) and escalates to standard on the
// first failed condition, so a reviewer is required again (trace `triage_escalated`).
//
// The path: the ledger stays (`Tier: trivial`, the foreman marks items), explorer, planner,
// reviewer and finalizer are skipped, one builder on its bottom rung makes the change (a `strong`
// launch without a ladder trigger escalates). It is on while `ceremony.required.trivial` names
// `builder` (the default); `required.trivial: []` restores the earlier trivial (no builder, any
// non-explorer launch escalates). In `bounded` mode the foreman may make the change itself,
// measured by trivialBound as before (bound.ts), so the builder step is not required there.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Step, TrivialBound } from "./bound.ts";
import { diffWithFacts, git, isTestPath, type DiffFact } from "./diffscan.ts";

export type TrivialReason = "test_file" | "files" | "signature" | "schema" | "bound" | "no_test" | "unmeasured";

export interface TrivialFacts {
  /** Changed non-test files outside `.workflow/` (repo-relative, forward slashes). */
  source: string[];
  /** Changed test files (isTestPath). */
  tests: string[];
  /** Added + removed lines over every changed file, untracked files' lines included. */
  lines: number;
  /** Files the diff adds plus untracked files. */
  newFiles: number;
  /** diffscan signature / removed facts (exported, or not exported but referenced by a test). */
  signatures: string[];
  /** A test file in the source file's directory (or below it), or a project test command. */
  covered: boolean;
}

/** The builder path is on while `ceremony.required.trivial` names `builder`. */
export function trivialBuilderPath(required: unknown): boolean {
  const v = required && typeof required === "object" ? (required as Record<string, unknown>).trivial : undefined;
  return Array.isArray(v) && v.includes("builder");
}

/**
 * The steps a finish at `tier` waits for. At trivial they apply only once a ledger is bound (a
 * change task; a question stays ledger-free) and the builder step is dropped in `bounded` mode,
 * where the foreman may make the change itself.
 */
export function effectiveRequired(steps: Step[], tier: string, opts: { bounded: boolean; ledger: boolean }): Step[] {
  if (tier !== "trivial") return steps;
  if (!opts.ledger) return [];
  return opts.bounded ? steps.filter((s) => s !== "builder") : steps;
}

const SCHEMA = /(^|\/)(migrations?|schemas?)\/|\.(proto|graphql|gql|sql|avsc|xsd|prisma)$|(^|[./_-])schema\.[a-z]+$/i;

/** A schema, migration or wire-format file by name. */
export function isSchemaPath(file: string): boolean {
  return SCHEMA.test(file.replace(/\\/g, "/"));
}

const isWorkflow = (f: string): boolean => /^(.*\/)?\.workflow\//.test(f);

/** Files, lines and new files of a unified diff, `.workflow/` excluded. */
export function diffShape(diff: string, skip: (f: string) => boolean = isWorkflow): { files: string[]; lines: number; newFiles: number } {
  const files: string[] = [];
  let lines = 0;
  let newFiles = 0;
  let file = "";
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = m && !skip(m[2]) ? m[2] : "";
      if (file && !files.includes(file)) files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk && raw.startsWith("new file mode")) newFiles++;
    else if (raw.startsWith("@@")) inHunk = true;
    else if (inHunk && (raw.startsWith("+") || raw.startsWith("-"))) lines++;
  }
  return { files, lines, newFiles };
}

/** A test file in `dir` or below it (`dir` "" = the repo root). */
export function hasTestNear(source: string, tracked: readonly string[]): boolean {
  const dir = path.posix.dirname(source);
  const prefix = dir === "." ? "" : `${dir}/`;
  return tracked.some((f) => f.startsWith(prefix) && isTestPath(f));
}

/** A project test command at the repo root: package.json `scripts.test`, Cargo.toml, go.mod, pytest/tox config, a Makefile `test:` target. */
export function hasTestCommand(files: readonly string[], read: (f: string) => string | null): boolean {
  if (files.includes("Cargo.toml") || files.includes("go.mod") || files.includes("pytest.ini") || files.includes("tox.ini")) return true;
  if (files.includes("pyproject.toml") && /^\[tool\.pytest/m.test(read("pyproject.toml") ?? "")) return true;
  if (files.includes("Makefile") && /^test\s*:/m.test(read("Makefile") ?? "")) return true;
  if (files.includes("package.json")) {
    try {
      const scripts = (JSON.parse(read("package.json") ?? "{}") as { scripts?: Record<string, unknown> }).scripts;
      if (scripts && typeof scripts.test === "string" && scripts.test.trim()) return true;
    } catch {
      // not JSON: no command
    }
  }
  return false;
}

/** Facts from the work diff, the untracked files (path, line count) and the tracked file list. */
export function trivialFacts(diff: string, facts: readonly DiffFact[], untracked: readonly { path: string; lines: number }[], tracked: readonly string[], testCommand: boolean, skip: (f: string) => boolean = isWorkflow): TrivialFacts {
  const shape = diffShape(diff, skip);
  const extra = untracked.filter((u) => !skip(u.path) && !shape.files.includes(u.path));
  const all = [...shape.files, ...extra.map((u) => u.path)];
  const source = all.filter((f) => !isTestPath(f));
  return {
    source,
    tests: all.filter((f) => isTestPath(f)),
    lines: shape.lines + extra.reduce((n, u) => n + u.lines, 0),
    newFiles: shape.newFiles + extra.length,
    signatures: facts.filter((f) => f.kind === "signature" || f.kind === "removed").map((f) => f.text),
    covered: source.length === 1 && (testCommand || hasTestNear(source[0], [...tracked, ...all])),
  };
}

/** Why the work is not trivial (the first failed condition), or null when it is. */
export function trivialVerdict(f: TrivialFacts, bound: TrivialBound): { reason: TrivialReason; detail: string } | null {
  if (f.tests.length > 0) return { reason: "test_file", detail: `test file changed: ${f.tests.slice(0, 3).join(", ")}` };
  if (f.source.length > 1) return { reason: "files", detail: `${f.source.length} source files changed` };
  if (f.signatures.length > 0) return { reason: "signature", detail: f.signatures[0] };
  const schema = f.source.find(isSchemaPath);
  if (schema) return { reason: "schema", detail: `schema file changed: ${schema}` };
  if (f.source.length > bound.files || f.lines > bound.lines || f.newFiles > bound.newFiles) {
    return { reason: "bound", detail: `${f.source.length} files, ${f.lines} changed lines, ${f.newFiles} new files (bound ${bound.files}, ${bound.lines}, ${bound.newFiles})` };
  }
  if (f.source.length === 1 && !f.covered) return { reason: "no_test", detail: `no test covers ${f.source[0]}` };
  return null;
}

const MAX_UNTRACKED = 200;
const MAX_READ = 1024 * 1024;

function readSmall(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_READ) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `.workflow/` and the foreman's scratch dir (workspace-relative; read as relative to the repo root) are not work. */
function skipper(scratchDir: string): (f: string) => boolean {
  const prefix = scratchDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return (f) => isWorkflow(f) || (prefix !== "" && (f === prefix || f.startsWith(`${prefix}/`)));
}

const lineCount =(t: string): number => (t === "" ? 0 : t.split(/\r?\n/).length - (t.endsWith("\n") ? 1 : 0));

/**
 * The check over every directory a builder worked in (`dirs`: directory and base; none = `cwd`
 * at HEAD). Null when the work is trivial; a git failure is `unmeasured` (fails closed).
 */
export async function checkTrivial(dirs: readonly [string, string | null][], cwd: string, bound: TrivialBound, scratchDir = ""): Promise<{ reason: TrivialReason; detail: string } | null> {
  const targets: [string, string | null][] = dirs.length > 0 ? [...dirs] : [[cwd, null]];
  const merged: TrivialFacts = { source: [], tests: [], lines: 0, newFiles: 0, signatures: [], covered: true };
  for (const [dir, base] of targets) {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"]))?.trim();
    if (!top) return { reason: "unmeasured", detail: `no git work tree at ${path.basename(dir) || dir}` };
    const r = await diffWithFacts(top, base);
    const others = await git(top, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const tracked = await git(top, ["ls-files", "-z"]);
    if (r.diff === null || others === null || tracked === null) return { reason: "unmeasured", detail: "git diff failed" };
    const untracked = others.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED).map((p) => ({ path: p, lines: lineCount(readSmall(path.join(top, p)) ?? "") }));
    const list = tracked.split("\0").filter(Boolean);
    const f = trivialFacts(r.diff, r.facts, untracked, list, hasTestCommand(list, (n) => readSmall(path.join(top, n))), skipper(scratchDir));
    for (const s of f.source) if (!merged.source.includes(s)) merged.source.push(s);
    merged.tests.push(...f.tests);
    merged.lines += f.lines;
    merged.newFiles += f.newFiles;
    merged.signatures.push(...f.signatures);
    merged.covered = merged.covered && (f.source.length === 0 || f.covered);
  }
  return trivialVerdict(merged, bound);
}

/** The text added to the finish refusal after an escalation. */
export function escalationNote(v: { reason: TrivialReason; detail: string }): string {
  return ` Not trivial after all (${v.reason}: ${v.detail}): the tier is now standard, so a reviewer must pass before you finish; launch one with the ledger items.`;
}
