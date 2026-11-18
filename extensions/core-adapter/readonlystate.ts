// Run-end state hint for reviewer and explorer launches (plan readonly-target v11, A and B).
//
// A reviewer or explorer should not change the checkout it works in, but nothing stops a shell line that does. The foreman pictures the checkout
// (the gate's tree root) before the child starts and again when the run ends, and compares the two; a difference is a notice, never a stop.
//
// Pictured (names and hashes only, never a setting value): HEAD and branch, the index (entries with their flags), the repository settings of the
// checkout (common and per-worktree config, in-repo includes, info/attributes, the effective hooks folder), the content of every tracked file that
// differs from the index or HEAD (lstat first, hashed through a non-blocking no-follow open), and the same for each initialized submodule.
// Not pictured: other refs, tags, the stash, untracked files, other worktrees, `.workflow/`, objects, settings outside the repository.
//
// Security: a planted `filter.<x>.clean` plus an attribute runs on the parent's `git status`. So the end picture reads the settings files first
// (file reads only); when settings, attributes or hooks differ from the start, no git runs and the result says the files were not compared.
// The start picture runs git under the settings present at launch, like the existing launch pictures (`headsAt`, `treesAt`).
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MAX_ITEMS, clean, listed, locateRepo, parseGitConfig, sha, type RepoDirs } from "./gitdrift.ts";

/** One git run in `cwd`: stdout, or a rejection (failure, timeout, abort). Tests inject a fake. */
export type GitRunner = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;

export const MAX_PATHS = 2000;
export const MAX_BYTES = 256 * 1024 * 1024;
export const MAX_SUBMODULES = 50;
export const GIT_TIMEOUT_MS = 10_000;
export const PICTURE_DEADLINE_MS = 20_000;
const MAX_INDEX_NAMES = 50_000;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 5;

export const START_UNREADABLE = "not compared: start unreadable";
export const END_UNREADABLE = "not compared: end unreadable";
export const COMPARE_FAILED = "state compare failed";
export const GATED_LINE = "files not compared (settings changed)";

/** The parent's git runs: no shell, no optional locks (status leaves the index untouched), no prompt, no hang past the per-run timeout. */
export const spawnGit: GitRunner = (cwd, args, signal) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 512 * 1024 * 1024, signal, windowsHide: true, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

// ------------------------------------------------------------------ the value object

interface Cfg {
  hash: string;
  /** Config files: masked key -> hash of (raw key, values); null for files that are not config. */
  keys: Map<string, string> | null;
}

interface Settings {
  /** Hash of the top, git dir and common dir paths (a moved or re-pointed git dir shows). */
  dirs: string;
  files: Map<string, Cfg>;
  /** Hash of the hooks dir path (the path is a config value, never stored). */
  hooksDirId: string;
  hooks: Map<string, string>;
}

interface Entry {
  /** The status code (`.M`, `M.`, `.D`, ...). */
  code: string;
  /** `sha:<hex>`, `link:<hash>`, `dir`, `type:<t>`, `absent`, `unreadable`; null for a regular file past the caps. */
  tag: string | null;
  /** lstat data; compared when one side has no tag. */
  ls: string;
}

interface GitPart {
  head: string | null;
  branch: string | null;
  indexHash: string;
  /** `<path>\t<stage>` -> `<flag> <mode> <oid>`; null past MAX_INDEX_NAMES. */
  index: Map<string, string> | null;
  dirty: Map<string, Entry>;
}

export interface TreeState {
  settings: Settings;
  /** Null: the end picture ran no git (settings changed). */
  git: GitPart | null;
  subs: Map<string, TreeState | "unreadable">;
  /** Initialized submodules at the end that the start did not picture (end pictures only). */
  newSubs: string[];
  /** The start left submodules out (over the limit). */
  subsOver: boolean;
}

export type Picture = TreeState | "unreadable";

interface Budget {
  paths: number;
  bytes: number;
  subs: number;
}

interface Ctx {
  home: string;
  git: GitRunner;
  signal: AbortSignal;
  budget: Budget;
}

// ------------------------------------------------------------------ file reads

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const gone = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException | null)?.code ?? "");

/** The bytes of a regular file (followed through links); "absent" when missing, "special" for a FIFO, device or directory (never opened for reading). */
async function readBytes(p: string, signal: AbortSignal): Promise<Buffer | "absent" | "special"> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(p, fs.constants.O_RDONLY | NONBLOCK);
  } catch (e) {
    if (gone(e)) return "absent";
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return "special";
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < MAX_CONFIG_BYTES) {
      if (signal.aborted) throw new Error("aborted");
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
    }
    return Buffer.concat(chunks);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** SHA-256 of a regular file's bytes, streamed; null when it is not a regular file or the bytes exceed `limit`. `follow` false: never through a final link. */
async function hashRegular(p: string, signal: AbortSignal, limit: number, follow: boolean): Promise<{ hex: string; bytes: number } | null> {
  const fh = await fsp.open(p, fs.constants.O_RDONLY | NONBLOCK | (follow ? 0 : NOFOLLOW));
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > limit) return null;
    const h = crypto.createHash("sha256");
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) return null;
      h.update(buf.subarray(0, bytesRead));
    }
    return { hex: h.digest("hex"), bytes: total };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ settings (file reads only)

/** Userinfo of any URL inside a key is masked: `url.https://u:pw@h/.insteadof` -> `url.https://***@h/.insteadof`. */
const maskKey = (k: string): string => k.replace(/\/\/[^/]*@/g, "//***@");
const BRANCH_TRACKING = /^branch\.(.+)\.(remote|merge|rebase)$/;

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The repository of exactly `dir` (a submodule or tree root), or null. */
function locate(dir: string): RepoDirs | null {
  const r = locateRepo(dir);
  return r && path.resolve(r.top) === path.resolve(dir) ? r : null;
}

async function takeSettings(repo: RepoDirs, ctx: Ctx): Promise<Settings> {
  const files = new Map<string, Cfg>();
  const roots = [repo.top, repo.gitDir, repo.commonDir];
  const label = (p: string): string => {
    for (const [name, r] of [["git", repo.commonDir], ["gitdir", repo.gitDir], ["repo", repo.top]] as const) {
      if (inside(r, p)) return `${name}:${path.relative(r, p).split(path.sep).join("/") || "."}`;
    }
    return p;
  };
  let hooksPath: string | null = null;
  const addConfig = async (p: string, depth: number): Promise<void> => {
    const lbl = label(p);
    if (files.has(lbl) || depth > MAX_INCLUDE_DEPTH) return;
    const bytes = await readBytes(p, ctx.signal);
    if (bytes === "absent") return;
    if (bytes === "special") {
      files.set(lbl, { hash: "special", keys: null });
      return;
    }
    const text = bytes.toString("utf8");
    const entries = parseGitConfig(text);
    const grouped = new Map<string, string[]>();
    for (const [k, v] of entries) grouped.set(maskKey(k), [...(grouped.get(maskKey(k)) ?? []), `${k}\0${v}`]);
    files.set(lbl, { hash: sha(bytes), keys: new Map([...grouped].map(([k, vs]) => [k, sha(vs.join("\u0001"))])) });
    for (const [k, v] of entries) {
      if (k === "core.hookspath" && depth === 0) hooksPath = v.replace(/^"(.*)"$/, "$1");
      if (!/^include(if\..*)?\.path$/.test(k)) continue;
      let target = v.replace(/^"(.*)"$/, "$1");
      if (target.startsWith("~/")) target = path.join(ctx.home, target.slice(2));
      target = path.resolve(path.dirname(p), target);
      if (roots.some((r) => inside(r, target))) await addConfig(target, depth + 1);
    }
  };
  const addRaw = async (p: string): Promise<void> => {
    const bytes = await readBytes(p, ctx.signal);
    if (bytes !== "absent") files.set(label(p), { hash: bytes === "special" ? "special" : sha(bytes), keys: null });
  };
  await addConfig(path.join(repo.commonDir, "config"), 0);
  await addConfig(path.join(repo.gitDir, "config.worktree"), 0);
  await addRaw(path.join(repo.commonDir, "info", "attributes"));
  if (repo.gitDir !== repo.commonDir) await addRaw(path.join(repo.gitDir, "info", "attributes"));
  const hp = hooksPath as string | null;
  const hooksDir = hp ? path.resolve(repo.top, hp.startsWith("~/") ? path.join(ctx.home, hp.slice(2)) : hp) : path.join(repo.commonDir, "hooks");
  const hooks = new Map<string, string>();
  let names: string[] = [];
  try {
    names = (await fsp.readdir(hooksDir)).sort();
  } catch (e) {
    if (!gone(e)) throw e;
  }
  for (const name of names) {
    const p = path.join(hooksDir, name);
    let st: fs.Stats;
    try {
      st = await fsp.stat(p);
    } catch (e) {
      if (gone(e)) continue;
      throw e;
    }
    if (st.isDirectory()) continue;
    if (!st.isFile()) {
      hooks.set(name, "special");
      continue;
    }
    try {
      const h = await hashRegular(p, ctx.signal, Number.MAX_SAFE_INTEGER, true);
      hooks.set(name, h ? h.hex : "special");
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      hooks.set(name, "unreadable");
    }
  }
  return { dirs: sha(`${repo.top}\0${repo.gitDir}\0${repo.commonDir}`), files, hooksDirId: sha(hooksDir), hooks };
}

/** Settings of a tree and of the submodules the start pictured (the end picture's first stage). */
interface SetTree {
  settings: Settings;
  subs: Map<string, SetTree | "unreadable">;
}

async function takeSetTree(dir: string, start: TreeState, ctx: Ctx): Promise<SetTree> {
  const repo = locate(dir);
  if (!repo) throw new Error("not a git tree");
  const settings = await takeSettings(repo, ctx);
  const subs = new Map<string, SetTree | "unreadable">();
  for (const [p, st] of start.subs) {
    if (st === "unreadable") continue;
    const sub = path.join(dir, p);
    if (!fs.existsSync(path.join(sub, ".git"))) continue;
    try {
      subs.set(p, await takeSetTree(sub, st, ctx));
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      subs.set(p, "unreadable");
    }
  }
  return { settings, subs };
}

/** Tracking keys of any branch are left out here: they run nothing, and the branch names are not known before git has run. */
const settingsDiffer = (a: Settings, b: Settings): boolean => settingsLines(a, b, new Set()).length > 0;

function setTreeDiffers(start: TreeState, end: SetTree): boolean {
  if (settingsDiffer(start.settings, end.settings)) return true;
  for (const [p, st] of start.subs) {
    const e = end.subs.get(p);
    if (st === "unreadable" || e === undefined) continue;
    if (e === "unreadable" || setTreeDiffers(st, e)) return true;
  }
  return false;
}

function gatedTree(start: TreeState, end: SetTree): TreeState {
  const subs = new Map<string, TreeState | "unreadable">();
  for (const [p, st] of start.subs) {
    const e = end.subs.get(p);
    if (st === "unreadable" || e === undefined) continue;
    subs.set(p, e === "unreadable" ? "unreadable" : gatedTree(st, e));
  }
  return { settings: end.settings, git: null, subs, newSubs: [], subsOver: false };
}

// ------------------------------------------------------------------ git stage

const GIT_BASE = ["-c", "core.fsmonitor=false"];
const NO_WORKFLOW = [".", ":(exclude).workflow"];

/** lstat first; a regular file is hashed through a non-blocking no-follow open that checks fstat; nothing here blocks or throws. */
async function contentOf(abs: string, ctx: Ctx): Promise<{ tag: string | null; ls: string }> {
  let st: fs.Stats;
  try {
    st = await fsp.lstat(abs);
  } catch (e) {
    return gone(e) ? { tag: "absent", ls: "absent" } : { tag: "unreadable", ls: "unreadable" };
  }
  const ls = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  if (st.isSymbolicLink()) {
    try {
      return { tag: `link:${sha(await fsp.readlink(abs))}`, ls };
    } catch {
      return { tag: "unreadable", ls };
    }
  }
  if (st.isDirectory()) return { tag: "dir", ls };
  if (!st.isFile()) return { tag: `type:${st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : st.isCharacterDevice() ? "char" : "other"}`, ls };
  if (ctx.budget.paths > MAX_PATHS || st.size > MAX_BYTES - ctx.budget.bytes) return { tag: null, ls };
  try {
    const h = await hashRegular(abs, ctx.signal, MAX_BYTES - ctx.budget.bytes, false);
    if (!h) return { tag: null, ls };
    ctx.budget.bytes += h.bytes;
    return { tag: `sha:${h.hex}`, ls };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { tag: "unreadable", ls };
  }
}

interface Listed {
  head: string | null;
  branch: string | null;
  paths: Array<[string, string]>;
}

function parseStatus(out: string): Listed {
  const r: Listed = { head: null, branch: null, paths: [] };
  const toks = out.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith("# branch.oid ")) r.head = t.slice(13);
    else if (t.startsWith("# branch.head ")) r.branch = t.slice(14);
    else if (t.startsWith("#")) continue;
    else if (t[0] === "1") r.paths.push([t.split(" ")[1], t.split(" ").slice(8).join(" ")]);
    else if (t[0] === "2") {
      r.paths.push([t.split(" ")[1], t.split(" ").slice(9).join(" ")]);
      i++; // the original path follows as its own record
    } else if (t[0] === "u") r.paths.push([t.split(" ")[1], t.split(" ").slice(10).join(" ")]);
  }
  return r;
}

async function takeGitPart(dir: string, ctx: Ctx): Promise<{ part: GitPart; gitlinks: string[] }> {
  const [ls, st] = await Promise.all([
    ctx.git(dir, [...GIT_BASE, "ls-files", "-s", "-v", "-z", "--", ...NO_WORKFLOW], ctx.signal),
    ctx.git(dir, [...GIT_BASE, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=no", "--ignore-submodules=all", "--", ...NO_WORKFLOW], ctx.signal),
  ]);
  const recs = ls.split("\0").filter(Boolean);
  const index: Map<string, string> | null = recs.length <= MAX_INDEX_NAMES ? new Map() : null;
  const gitlinks: string[] = [];
  for (const rec of recs) {
    const tab = rec.indexOf("\t");
    const [flag, mode, oid, stage] = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    index?.set(`${p}\t${stage}`, `${flag} ${mode} ${oid}`);
    if (mode === "160000") gitlinks.push(p);
  }
  const status = parseStatus(st);
  const dirty = new Map<string, Entry>();
  for (let i = 0; i < status.paths.length; i += 32) {
    const chunk = status.paths.slice(i, i + 32);
    const got = await Promise.all(chunk.map(async ([, p]) => {
      ctx.budget.paths++;
      return contentOf(path.join(dir, p), ctx);
    }));
    chunk.forEach(([code, p], n) => dirty.set(p, { code, ...got[n] }));
  }
  return { part: { head: status.head, branch: status.branch, indexHash: sha(ls), index, dirty }, gitlinks };
}

/** Initialized submodule checkouts below `dir`: gitlink paths with a `.git`. */
const initialized = (dir: string, gitlinks: string[]): string[] => gitlinks.filter((p) => fs.existsSync(path.join(dir, p, ".git")));

async function takeTree(dir: string, ctx: Ctx, start?: TreeState, pre?: SetTree): Promise<TreeState> {
  const settings = pre?.settings ?? (await takeSettings(locateOrThrow(dir), ctx));
  const { part, gitlinks } = await takeGitPart(dir, ctx);
  const subs = new Map<string, TreeState | "unreadable">();
  const newSubs: string[] = [];
  let subsOver = false;
  for (const p of initialized(dir, gitlinks)) {
    const sub = path.join(dir, p);
    if (start) {
      const st = start.subs.get(p);
      if (!st || st === "unreadable") {
        newSubs.push(p);
        continue;
      }
      const e = pre?.subs.get(p);
      try {
        subs.set(p, await takeTree(sub, ctx, st, e === "unreadable" ? undefined : e));
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        subs.set(p, "unreadable");
      }
      continue;
    }
    if (ctx.budget.subs >= MAX_SUBMODULES) {
      subsOver = true;
      continue;
    }
    ctx.budget.subs++;
    try {
      subs.set(p, await takeTree(sub, ctx));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      subs.set(p, "unreadable");
    }
  }
  return { settings, git: part, subs, newSubs, subsOver: start ? start.subsOver : subsOver };
}

function locateOrThrow(dir: string): RepoDirs {
  const r = locate(dir);
  if (!r) throw new Error("not a git tree");
  return r;
}

/**
 * The picture of the tree rooted at `root` (the gate's tree root). With `start` it is an end picture: the settings files are read first and, when they
 * differ from the start (settings, attributes, hooks, a moved git dir, in the tree or a submodule), no git runs. Any exception gives "unreadable".
 */
export async function takeReadonlyState(root: string, home: string, git: GitRunner, start?: Picture, opts: { signal?: AbortSignal } = {}): Promise<Picture> {
  try {
    const ctx: Ctx = { home, git, signal: opts.signal ?? new AbortController().signal, budget: { paths: 0, bytes: 0, subs: 0 } };
    if (start && start !== "unreadable") {
      const set = await takeSetTree(root, start, ctx);
      if (setTreeDiffers(start, set)) return gatedTree(start, set);
      return await takeTree(root, ctx, start, set);
    }
    return await takeTree(root, ctx);
  } catch {
    return "unreadable";
  }
}

// ------------------------------------------------------------------ diff

/** Change lines of the settings (names only); tracking keys of a branch other than `branches` are left out. */
function settingsLines(a: Settings, b: Settings, branches: Set<string>): string[] {
  const out: string[] = [];
  if (a.dirs !== b.dirs) out.push("git directory location changed");
  const drop = (k: string): boolean => {
    const m = BRANCH_TRACKING.exec(k);
    return !!m && !branches.has(m[1]);
  };
  for (const lbl of [...new Set([...a.files.keys(), ...b.files.keys()])].sort()) {
    const fa = a.files.get(lbl);
    const fb = b.files.get(lbl);
    if (fa && fb && fa.hash === fb.hash) continue;
    const name = clean(lbl);
    const kb = new Map([...(fb?.keys ?? [])].filter(([k]) => !drop(k)));
    if (!fa) {
      out.push(`${name}: new file${kb.size ? ` (${listed("keys", [...kb.keys()])})` : ""}`);
      continue;
    }
    if (!fb) {
      out.push(`${name}: removed`);
      continue;
    }
    const ka = new Map([...(fa.keys ?? [])].filter(([k]) => !drop(k)));
    const added = [...kb.keys()].filter((k) => !ka.has(k));
    const removed = [...ka.keys()].filter((k) => !kb.has(k));
    const changed = [...kb.keys()].filter((k) => ka.has(k) && ka.get(k) !== kb.get(k));
    const parts = [listed("added", added), listed("changed", changed), listed("removed", removed)].filter(Boolean);
    if (parts.length) {
      out.push(`${name}: ${parts.join("; ")}`);
      continue;
    }
    // keys equal after the filter: a difference outside the keys (a comment, a file that is no config) is a content change; only filtered keys differing is none
    const fullA = [...(fa.keys ?? [])].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const fullB = [...(fb.keys ?? [])].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    if (fullA === fullB) out.push(`${name}: content changed`);
  }
  if (a.hooksDirId !== b.hooksDirId) out.push("hooks directory changed (core.hooksPath)");
  const hooks = [...new Set([...a.hooks.keys(), ...b.hooks.keys()])].sort();
  const parts = [
    listed("added", hooks.filter((h) => !a.hooks.has(h))),
    listed("changed", hooks.filter((h) => a.hooks.has(h) && b.hooks.has(h) && a.hooks.get(h) !== b.hooks.get(h))),
    listed("removed", hooks.filter((h) => !b.hooks.has(h))),
  ].filter(Boolean);
  if (parts.length) out.push(`hooks: ${parts.join("; ")}`);
  return out;
}

function entryChanged(x: Entry | undefined, y: Entry | undefined): boolean {
  if (!x || !y) return x !== y;
  if (x.code !== y.code) return true;
  return x.tag !== null && y.tag !== null ? x.tag !== y.tag : x.ls !== y.ls;
}

const short = (s: string | null): string => (s ?? "none").slice(0, 8);

function diffTree(a: TreeState, b: TreeState): string[] {
  const out: string[] = [];
  const branches = new Set([a.git?.branch, b.git?.branch].filter((x): x is string => typeof x === "string"));
  out.push(...settingsLines(a.settings, b.settings, branches));
  if (a.git && b.git) {
    if (a.git.head !== b.git.head) out.push(`HEAD ${short(a.git.head)} -> ${short(b.git.head)}`);
    if (a.git.branch !== b.git.branch) out.push(`branch ${clean(a.git.branch ?? "none")} -> ${clean(b.git.branch ?? "none")}`);
    if (a.git.indexHash !== b.git.indexHash) {
      const ia = a.git.index;
      const ib = b.git.index;
      if (ia && ib) {
        const keys = [...new Set([...ia.keys(), ...ib.keys()])].filter((k) => ia.get(k) !== ib.get(k));
        out.push(listed("index entries changed", [...new Set(keys.map((k) => k.split("\t")[0]))]) ?? "index changed");
      } else out.push("index changed");
    }
    const paths = [...new Set([...a.git.dirty.keys(), ...b.git.dirty.keys()])].sort().filter((p) => entryChanged(a.git!.dirty.get(p), b.git!.dirty.get(p)));
    const l = listed("tracked files changed", paths);
    if (l) out.push(l);
  }
  for (const p of [...new Set([...a.subs.keys(), ...b.subs.keys()])].sort()) {
    const sa = a.subs.get(p);
    const sb = b.subs.get(p);
    const pre = `${clean(p)}: `;
    if (sa === undefined || sa === "unreadable") continue;
    if (sb === undefined) out.push(`${pre}submodule no longer initialized`);
    else if (sb === "unreadable") out.push(`${pre}not readable at the end`);
    else out.push(...diffTree(sa, sb).map((x) => `${pre}${x}`));
  }
  for (const p of a.subs.keys()) if (a.subs.get(p) === "unreadable" && b.subs.has(p)) out.push(`${clean(p)}: not compared (start unreadable)`);
  const fresh = listed("new submodule(s), not compared:", b.newSubs);
  if (fresh) out.push(fresh);
  if (a.subsOver) out.push(`submodules not compared: over ${MAX_SUBMODULES}`);
  return out;
}

const gated = (t: TreeState): boolean => t.git === null || [...t.subs.values()].some((s) => s !== "unreadable" && gated(s));

/** What changed between two pictures, as short lines (names only, never values). Empty = nothing. */
export function diffReadonlyState(a: Picture, b: Picture): string[] {
  if (a === "unreadable") return [START_UNREADABLE];
  if (b === "unreadable") return [END_UNREADABLE];
  try {
    const lines = diffTree(a, b);
    if (gated(b)) lines.push(GATED_LINE);
    return lines;
  } catch {
    return [COMPARE_FAILED];
  }
}

// ------------------------------------------------------------------ sets, launches, run end

/** Pictures of several roots in parallel under one deadline; at the deadline running git processes are killed and unfinished pictures are unreadable. */
export async function pictureSet(roots: readonly string[], home: string, git: GitRunner, starts?: ReadonlyMap<string, Picture>, ms = PICTURE_DEADLINE_MS): Promise<Map<string, Picture>> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"unreadable">((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve("unreadable");
    }, ms);
  });
  try {
    const skip = (r: string): boolean => !!starts && (starts.get(r) === undefined || starts.get(r) === "unreadable"); // the start is lost: the compare says so, no git runs for it
    const got = await Promise.all(roots.map(async (r) => [r, skip(r) ? "unreadable" : await Promise.race([takeReadonlyState(r, home, git, starts?.get(r), { signal: ctl.signal }), late])] as [string, Picture]));
    return new Map(got);
  } finally {
    clearTimeout(timer);
  }
}

/** What the foreman keeps per launch until the run ends. */
export type StartEntry = { kind: "picture"; roots: string[]; states: Map<string, Picture> } | { kind: "no tree" } | { kind: "not pictured" };

export async function takeStartEntry(roots: readonly string[], home: string, git: GitRunner, ms = PICTURE_DEADLINE_MS): Promise<StartEntry> {
  if (roots.length === 0) return { kind: "no tree" };
  return { kind: "picture", roots: [...roots], states: await pictureSet(roots, home, git, undefined, ms) };
}

export type CompareOutcome = "changed" | "unchanged" | "not_compared" | "settings_changed";

export interface RunCompare {
  outcome: CompareOutcome;
  /** `start unreadable` or `end unreadable` for a not-compared root. */
  reason?: string;
  /** Per root, the change lines (a not-compared root carries its one line). */
  perRoot: Array<{ root: string; lines: string[]; notCompared: boolean }>;
}

/** The end pictures of a run's roots compared with its start entry (never throws). */
export async function compareRunEnd(start: Extract<StartEntry, { kind: "picture" }>, home: string, git: GitRunner, ms = PICTURE_DEADLINE_MS): Promise<RunCompare> {
  let end: Map<string, Picture>;
  try {
    end = await pictureSet(start.roots, home, git, start.states, ms);
  } catch {
    end = new Map(start.roots.map((r) => [r, "unreadable" as const]));
  }
  const perRoot = start.roots.map((root) => {
    const lines = diffReadonlyState(start.states.get(root) ?? "unreadable", end.get(root) ?? "unreadable");
    return { root, lines, notCompared: lines.length === 1 && (lines[0] === START_UNREADABLE || lines[0] === END_UNREADABLE) };
  });
  const nc = perRoot.find((r) => r.notCompared);
  const changed = perRoot.filter((r) => !r.notCompared && r.lines.length > 0);
  const outcome: CompareOutcome = changed.some((r) => r.lines.includes(GATED_LINE)) ? "settings_changed" : changed.length ? "changed" : nc ? "not_compared" : "unchanged";
  return { outcome, ...(nc ? { reason: nc.lines[0] === START_UNREADABLE ? "start unreadable" : "end unreadable" } : {}), perRoot };
}

const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, "?");

/** The notice text: per root what differs (change lines through `clean` and a 12-line cap) or why it was not compared. */
export function noticeText(role: string, runId: string, r: RunCompare): string {
  const parts = r.perRoot.filter((x) => x.lines.length > 0).map((x) => {
    const where = plain(x.root);
    if (x.notCompared) return `${where} was not compared: ${x.lines[0].replace(/^not compared: /, "")}`;
    const lines = x.lines.slice(0, MAX_ITEMS).map((l) => plain(l).slice(0, 400));
    return `${where} differs from its state at launch: ${lines.join("; ")}${x.lines.length > MAX_ITEMS ? ` (+${x.lines.length - MAX_ITEMS} more)` : ""}`;
  });
  return `pi-foreman notice: ${role} run ${runId.slice(0, 8)} ended and ${parts.join(" and ")}. Nothing was blocked or undone; check whether the run, a builder, another run in that checkout or you made the change.`;
}

/** The change lines of a compare, capped and cleaned, for the trace (no values). */
export function traceLines(r: RunCompare): string[] {
  const all = r.perRoot.flatMap((x) => x.lines);
  return all.slice(0, MAX_ITEMS).map((l) => plain(l).slice(0, 200));
}

/** A role list that is not empty and is all reviewer or explorer: the launches the hint covers. */
export function readonlyRoles(roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((r) => r === "reviewer" || r === "explorer");
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The directories a launch's children run in, as pi-subagents resolves them: the top-level `cwd` against the session cwd, else the session cwd; each
 * entry's `cwd` (nested `parallel` steps too) against the launch cwd, an entry without one uses the launch cwd. Only entries that name an agent count.
 */
export function launchRunCwds(input: unknown, sessionCwd: string): string[] {
  const resolve = (base: string, c: unknown): string => (typeof c === "string" && c ? path.resolve(base, c) : base);
  const launch = isObj(input) ? resolve(sessionCwd, input.cwd) : sessionCwd;
  const out = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (!isObj(v) || depth > 8) return;
    if (typeof v.agent === "string" && v.agent) out.add(resolve(launch, v.cwd));
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(v[k])) for (const step of v[k] as unknown[]) visit(step, depth + 1);
  };
  visit(input, 0);
  return [...out];
}
