// The session folder (D118): a foreman session started by hand in a primary checkout gets its own linked worktree at its first builder launch.
// Naming follows scripts/foreman_session.py `plan_worktree` (path `<close.worktreeDir>/<slug>`, branch `<sessions.worktree.branchPrefix>/<slug>`);
// the base rule differs on purpose (a repository without `origin` still launches builders: base HEAD). Nothing here throws.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { mainCheckoutOf, resolveWorktreeRoot, rootCollision } from "./worktreeroot.ts";

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// characters that cannot be passed safely in a pane command (foreman_session.py PATH_BAD)
// eslint-disable-next-line no-control-regex
const PATH_BAD = /[\x00-\x1f\x7f\u2018-\u201e'"`$;|&<>(){}[\]*?!#%^,]/;
const MAX_LABEL = 40;
const SUFFIXES = [2, 3, 4, 5, 6, 7, 8, 9];
export const DEFAULT_BRANCH_PREFIX = "round";
export const FETCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;

export interface SessionFolder {
  path: string;
  branch: string;
}

export type FolderResult =
  | { ok: true; folder: SessionFolder; base: string; created: boolean; dirty: boolean; ahead: number; staleNote?: string }
  | { ok: false; reason: string };

interface Out {
  code: number;
  out: string;
}

function git(cwd: string, args: string[], timeout: number = GIT_TIMEOUT_MS): Promise<Out> {
  return new Promise((resolve) => {
    try {
      execFile("git", args, { cwd, encoding: "utf8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, out: String(stdout ?? "").trim() });
      });
    } catch {
      resolve({ code: 1, out: "" });
    }
  });
}

/** The top of the git checkout holding `cwd` when it is a primary checkout (not a linked worktree); null otherwise, or when git does not answer. */
export async function primaryCheckout(cwd: string): Promise<string | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.out) return null;
  const dirs = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  const [gitDir, common] = dirs.out.split("\n");
  if (dirs.code !== 0 || !gitDir || !common) return null;
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
  return real(gitDir) === real(common) ? top.out : null;
}

/** The slug of the session folder: the session name lowercased, runs outside `[a-z0-9-]` as `-`, at most 40 characters; `s-<first 8 of the id>` when empty or reserved. */
export function folderSlug(name: string | undefined, id: string): string {
  const clean = (v: string): string => v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_LABEL).replace(/-+$/, "");
  const slug = clean(name ?? "");
  if (slug && slug !== "worktrees") return slug;
  return `s-${clean(id).slice(0, 8) || "session"}`;
}

const route = " Pass an explicit `cwd` in the launch to run in the checkout you name, or open a session folder yourself with `foreman_session_open` (`worktree: true`).";
const refuse = (reason: string): FolderResult => ({ ok: false, reason: reason + route });

/** The base of the new branch: `[ref, staleNote]`, or an error text. */
async function baseOf(repo: string): Promise<{ base: string; staleNote?: string } | { error: string }> {
  const origin = await git(repo, ["remote", "get-url", "origin"]);
  if (origin.code !== 0) return { base: "HEAD" };
  const cur = await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (cur.code !== 0 || !cur.out) return { base: "HEAD" };
  let def: string | null = null;
  const head = await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.startsWith("refs/remotes/origin/")) def = head.out.slice("refs/remotes/origin/".length);
  else {
    const remote = await git(repo, ["ls-remote", "--symref", "origin", "HEAD"], FETCH_TIMEOUT_MS);
    const m = remote.code === 0 ? /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remote.out) : null;
    def = m ? m[1] : null;
  }
  if (cur.out !== def && def !== null) return { base: "HEAD" };
  if (def === null) return { error: `the default branch of origin cannot be found in ${repo}` };
  const fetched = await git(repo, ["fetch", "origin"], FETCH_TIMEOUT_MS);
  const ref = `origin/${def}`;
  const have = (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
  if (fetched.code === 0 && have) return { base: ref };
  if (!have) return { error: `git fetch origin failed in ${repo} and ${ref} does not exist locally` };
  return { base: ref, staleNote: `git fetch origin failed; the base ${ref} is the last fetched state and may be stale` };
}

/**
 * The session folder for a session in the primary checkout `cwd`: `recorded` when it is still there, else a new linked worktree. `worktreeDir` and
 * `branchPrefix` are the `close.worktreeDir` and `sessions.worktree.branchPrefix` settings as configured.
 */
export async function ensureSessionFolder(i: { cwd: string; sessionId: string; sessionName?: string; worktreeDir: unknown; branchPrefix: unknown; recorded: SessionFolder | null }): Promise<FolderResult> {
  try {
    const top = await git(i.cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || !top.out) return refuse(`the session folder cannot be made: ${i.cwd} is not in a git checkout.`);
    const main = mainCheckoutOf(top.out);
    if (!main) return refuse(`the session folder cannot be made: the main checkout of ${top.out} is not found.`);
    if (i.recorded && fs.existsSync(path.join(i.recorded.path, ".git"))) return { ok: true, folder: i.recorded, base: "", created: false, dirty: false, ahead: 0 };
    const dirty = (await git(top.out, ["status", "--porcelain"])).out !== "";
    const prefix = i.branchPrefix === undefined || i.branchPrefix === null ? DEFAULT_BRANCH_PREFIX : i.branchPrefix;
    if (typeof prefix !== "string" || !LABEL_RE.test(prefix)) return refuse("sessions.worktree.branchPrefix must be 1-40 characters of A-Z a-z 0-9 . _ - and start with a letter or digit.");
    const root = resolveWorktreeRoot(main, i.worktreeDir);
    if (root.error) return refuse(`the session folder cannot be made: ${root.error.message}.`);
    const clash = rootCollision(main, root.spelled);
    if (clash) return refuse(`the session folder cannot be made: ${clash.message}.`);
    const slug = folderSlug(i.sessionName, i.sessionId);
    let picked: SessionFolder | null = null;
    for (const n of [1, ...SUFFIXES]) {
      const label = n === 1 ? slug : `${slug.slice(0, MAX_LABEL - String(n).length - 1).replace(/-+$/, "")}-${n}`;
      const p = path.join(root.spelled, label);
      const branch = `${prefix}/${label}`;
      if (!LABEL_RE.test(label) || PATH_BAD.test(p)) return refuse(`the session folder path has characters that cannot be passed safely: ${p}.`);
      if ((await git(main, ["check-ref-format", `refs/heads/${branch}`])).code !== 0) return refuse(`${branch} is not a valid branch name.`);
      if (fs.lstatSync(p, { throwIfNoEntry: false })) continue;
      if ((await git(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) continue;
      picked = { path: p, branch };
      break;
    }
    if (!picked) return refuse(`every session folder name from ${slug} to ${slug}-9 is taken (path or branch) under ${root.spelled}.`);
    const base = await baseOf(main);
    if ("error" in base) return refuse(`the session folder cannot be made: ${base.error}.`);
    fs.mkdirSync(root.spelled, { recursive: true });
    const add = await git(main, ["worktree", "add", "--no-track", picked.path, "-b", picked.branch, base.base], FETCH_TIMEOUT_MS);
    if (add.code !== 0) return refuse(`git worktree add ${picked.path} failed (branch ${picked.branch}, base ${base.base}).`);
    // local commits of the primary checkout that the base (origin/<default>) lacks
    const aheadOut = base.base === "HEAD" ? null : await git(main, ["rev-list", "--count", `${base.base}..HEAD`]);
    const ahead = aheadOut && aheadOut.code === 0 ? Number(aheadOut.out) || 0 : 0;
    return { ok: true, folder: picked, base: base.base, created: true, dirty, ahead, ...(base.staleNote ? { staleNote: base.staleNote } : {}) };
  } catch (err) {
    return refuse(`the session folder cannot be made: ${(err as Error).message}.`);
  }
}

/** The one line of the launch result for a launch that runs in the session folder. */
export function folderLine(r: Extract<FolderResult, { ok: true }>): string {
  const head = r.created
    ? `pi-foreman: this session now has its own folder ${r.folder.path} (branch ${r.folder.branch}, from ${r.base}); launches without a cwd run there`
    : `pi-foreman: this launch runs in the session folder ${r.folder.path} (branch ${r.folder.branch})`;
  return `${head}. Use it as the directory of your own git commands and pass it as cwd to pr_create (the PR tools are not redirected).${r.created && r.dirty ? " The primary checkout has uncommitted changes; they are not in the session folder." : ""}${r.created && r.ahead > 0 ? ` The primary checkout has ${r.ahead} local commit${r.ahead === 1 ? "" : "s"} not on ${r.base}; ${r.ahead === 1 ? "it is" : "they are"} not in the session folder.` : ""}${r.staleNote ? ` Note: ${r.staleNote}.` : ""}`;
}
