// The gate's own, deterministic fact about a script-file run for the review (never the model's call): is the file inside the repo,
// tracked by git and unchanged against HEAD. `bash x.sh`, `sh x.sh`, `./x.sh`, `node scripts/x.mjs`, `python x.py`: the first
// non-option argument is a file. Any git failure counts as not tracked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseShell } from "./shellast.ts";

export type ScriptState = "tracked-unchanged" | "modified" | "untracked" | "outside-repo";

const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "node", "python", "python3", "ruby", "perl", "deno", "tsx", "bun"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const GIT_TIMEOUT_MS = 3000;
const MAX_FACTS = 5;

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function git(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The state of one script file, given the worktree root. */
export function scriptState(file: string, cwd: string, worktree: string): { rel: string; state: ScriptState } {
  const abs = path.resolve(cwd, file);
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const root = real(worktree);
  const target = real(abs);
  if (!inside(target, root)) return { rel: file, state: "outside-repo" };
  const rel = path.relative(root, target).split(path.sep).join("/");
  if (!git(["ls-files", "--error-unmatch", "--", rel], root)) return { rel, state: "untracked" };
  return { rel, state: git(["diff", "--quiet", "HEAD", "--", rel], root) ? "tracked-unchanged" : "modified" };
}

/** The script files a command line runs (first non-option argument of an interpreter, or a path program like `./x.sh`). */
export function scriptFiles(command: string, cwd: string): { file: string; cwd: string }[] {
  const out: { file: string; cwd: string }[] = [];
  for (const seg of parseShell(command, { cwd })) {
    const at = seg.cwd ?? cwd;
    let file: string | undefined;
    if (INTERPRETERS.has(path.basename(seg.program))) {
      const inline = SHELLS.has(path.basename(seg.program)) ? /^-[a-zA-Z]*c$/ : /^-[a-zA-Z]*[cep]$/; // `sh -e` is errexit, `node -e` is a script
      if (seg.argv.some((a) => inline.test(a) || a === "--eval")) continue; // inline script: not a file
      file = seg.argv.find((a) => !a.startsWith("-"));
    } else if (seg.program.includes("/")) {
      file = seg.program;
    }
    if (file && !file.includes("$")) out.push({ file, cwd: at });
  }
  return out.slice(0, MAX_FACTS);
}

/** Context fact lines for the review, e.g. `script: scripts/x.sh tracked-unchanged`; empty when the line runs no script file. */
export function scriptFacts(command: string, cwd: string, worktree: string): string[] {
  try {
    return scriptFiles(command, cwd).map((s) => {
      const r = scriptState(s.file, s.cwd, worktree);
      return `script: ${r.rel} ${r.state}`;
    });
  } catch {
    return [];
  }
}
