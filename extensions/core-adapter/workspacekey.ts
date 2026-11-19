// Identity of the repository a session works in, for the findings store (docs/review.md): the workspace key of the MAIN checkout
// (same formula as `derive_key` and `workspace_key` of scripts/foreman_backlog.py) and `owner/name` of its remote.
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { locateRepo } from "./gitdrift.ts";
import { validRepo } from "./prhost.ts";

/** Python `sanitize_key`: `/`-separated segments of [A-Za-z0-9._-], other characters become `-`; throws on an empty key or a `.`/`..` segment. */
export function sanitizeKey(key: string): string {
  const segs = String(key ?? "").replace(/\\/g, "/").split("/").filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9._-]/gu, "-"));
  if (segs.length === 0) throw new Error("empty workspace key");
  if (segs.some((s) => s === "." || s === "..")) throw new Error(`workspace key may not contain '.' or '..' segments: ${key}`);
  return segs.join("/");
}

/** Python `derive_key` on an already resolved path: `<basename>-<first 8 hex of sha1(normalised path)>`. `platform` is the one whose path rules apply. */
export function deriveKey(real: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  const trimmed = real.replace(/[\\/]+$/, "");
  const last = (win ? trimmed.split(/[\\/]/) : trimmed.split("/")).pop() ?? "";
  const base = (win && /^[A-Za-z]:$/.test(last) ? "" : last) || "root";
  // os.path.normcase: Windows lowercases and uses backslashes; macOS and Windows file systems are case folded (safe_ops.norm)
  const normal = win ? real.replace(/\//g, "\\").toLowerCase() : platform === "darwin" ? real.toLowerCase() : real;
  return sanitizeKey(`${base}-${crypto.createHash("sha1").update(normal, "utf8").digest("hex").slice(0, 8)}`);
}

// Python `str.strip()` whitespace: JS `\s` minus U+FEFF, plus the separators U+001C-U+001F and U+0085
const PY_BLANK = /^(?:(?!\uFEFF)[\s\x1c-\x1f\x85])*$/;

/** Python `workspace_key`: the `retro.workspaceKey` override (sanitised) when it is a non-blank string, else the key derived from `root`'s real path. */
export function workspaceKey(root: string, override?: unknown): string {
  if (typeof override === "string" && !PY_BLANK.test(override)) return sanitizeKey(override);
  return deriveKey(realPath(path.resolve(root)));
}

/** Python `os.path.realpath`: the native variant expands Windows 8.3 short names (`RUNNER~1`) and drops the `\\?\` prefix as Python does; the JS variant does neither. Falls back to the JS one, then to `p`. */
export function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }
}

/** The main checkout of `cwd`: the parent of the git common dir when that dir is named `.git` (a linked worktree resolves to its main checkout); a submodule or bare layout and a folder outside git use the workspace root. */
export function mainCheckout(cwd: string): string {
  const repo = locateRepo(cwd);
  if (!repo) return path.resolve(cwd);
  return path.basename(repo.commonDir) === ".git" ? path.dirname(repo.commonDir) : repo.top;
}

/** Workspace key of the main checkout of `cwd`. */
export function workspaceKeyOf(cwd: string, override?: unknown): string {
  return workspaceKey(mainCheckout(cwd), override);
}

/** The branch HEAD of `cwd`'s checkout names (file read), null when detached or outside git. */
export function currentBranch(cwd: string): string | null {
  const repo = locateRepo(cwd);
  if (!repo) return null;
  try {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(fs.readFileSync(path.join(repo.gitDir, "HEAD"), "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const REMOTE_URL = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[A-Za-z0-9.-]+(?::\d+)?[:/](.+?)(?:\.git)?\/?$/;

/** `owner/name` of the `origin` remote, else of the first remote by name, else null (also on any git failure). */
export function repoOf(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["remote", "-v"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const byName = new Map<string, string>();
      for (const line of String(stdout).split("\n")) {
        const [name, url] = line.split(/\s+/);
        const m = name && url ? REMOTE_URL.exec(url) : null;
        if (m && validRepo(m[1]) && !byName.has(name)) byName.set(name, m[1]);
      }
      const first = [...byName.keys()].sort()[0];
      resolve(byName.get("origin") ?? (first !== undefined ? byName.get(first) ?? null : null));
    });
  });
}
