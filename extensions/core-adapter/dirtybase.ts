// Per-checkout baseline of a session (ledger session-own-changes): which paths of a checkout were already changed when the
// session first worked there, each with a fingerprint of its content. The trivial finish check, the "unreviewed work"
// reminder and the close report (scripts/foreman_close.py, same hash spec) count only what differs from it.
//
// Hash spec (shared with foreman_close.py, same test vectors):
//   missing path            "deleted"        (lstat fails with ENOENT or ENOTDIR)
//   any other lstat/read error "unreadable"
//   unchanged               a baseline value counts as unchanged only when the current one is equal and is neither "unreadable"
//                           nor a "dir:" digest (a nested repository may change inside without changing its status text: fail closed)
//   symlink                 "link:" + sha256(readlink text, utf-8)[:16]
//   directory               "dir:" + sha256(HEAD (trimmed, "" when none) + "\n" + `git status --porcelain=v1 -z --untracked-files=all` inside it)[:16]
//   regular file            sha256(bytes)[:16] + ":x" when any exec bit is set (never on win32); over 64 MiB "big:" + size + ":" + (mtime in ns // 1_000_000)
// The listing is `git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all` with both sides of a rename or copy,
// backslashes to `/` (foreman_sync.status_paths). More than 2000 paths: no per-path map (`paths: null`).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./diffscan.ts";

export interface DirtyEntry {
  repo: string;
  head: string | null;
  paths: Record<string, string> | null;
}
/** Keyed by `checkoutKey`; null on a session (legacy: no baseline), `{}` on a new one. */
export type DirtyBase = Record<string, DirtyEntry>;

export const MAX_BASE_PATHS = 2000;
export const BIG_FILE = 64 * 1024 * 1024;

const sha16 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** The identity of a checkout toplevel: real path, `/` separators, lowercased on win32 and darwin (safe_ops.norm). */
export function checkoutKey(top: string, platform: string = process.platform): string {
  let real = top;
  try {
    real = fs.realpathSync.native(top);
  } catch {
    // keep the given path
  }
  const k = real.replace(/\\/g, "/");
  return platform === "win32" || platform === "darwin" ? k.toLowerCase() : k;
}

/** The digest of a directory entry's state: its HEAD (trimmed, "" when none) and its raw `git status -z` text. */
export function dirDigest(head: string, status: string): string {
  return `dir:${sha16(`${head}\n${status}`)}`;
}

/** Repo-relative `/` paths of `git status -z` output, both sides of a rename or copy, in first-seen order. */
export function parseStatusZ(out: string): string[] {
  const parts = out.split("\0");
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; ) {
    const rec = parts[i++];
    if (rec.length < 4) continue;
    seen.add(rec.slice(3).replace(/\\/g, "/"));
    if (rec.slice(0, 2).includes("R") || rec.slice(0, 2).includes("C")) {
      if (i < parts.length && parts[i]) seen.add(parts[i].replace(/\\/g, "/"));
      i++;
    }
  }
  return [...seen];
}

/** The changed and untracked paths of the checkout at `top`; null when git fails. */
export async function dirtyPaths(top: string): Promise<string[] | null> {
  const out = await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  return out === null ? null : parseStatusZ(out);
}

/** The fingerprint of one path of the checkout at `top` (see the spec at the top). */
export async function hashPath(top: string, rel: string): Promise<string> {
  const p = path.join(top, ...rel.split("/"));
  let st: fs.BigIntStats;
  try {
    st = await fs.promises.lstat(p, { bigint: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "deleted" : "unreadable";
  }
  try {
    if (st.isSymbolicLink()) return `link:${sha16(Buffer.from(await fs.promises.readlink(p), "utf8"))}`;
    if (st.isDirectory()) {
      const head = ((await git(p, ["rev-parse", "HEAD"])) ?? "").trim();
      const status = (await git(p, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) ?? "";
      return dirDigest(head, status);
    }
    if (st.size > BigInt(BIG_FILE)) return `big:${st.size}:${st.mtimeNs / 1000000n}`;
    const exec = process.platform !== "win32" && (st.mode & 0o111n) !== 0n ? ":x" : "";
    return sha16(await fs.promises.readFile(p)) + exec;
  } catch {
    return "unreadable";
  }
}

/** The real toplevel and key of the checkout `dir` belongs to; null when git fails or `dir` is no work tree. */
export async function resolveCheckout(dir: string, platform: string = process.platform): Promise<{ top: string; key: string } | null> {
  const topRaw = (await git(dir, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!topRaw) return null;
  try {
    const top = fs.realpathSync.native(topRaw);
    return { top, key: checkoutKey(top, platform) };
  } catch {
    return null;
  }
}

/** A session's memo of the checkout each directory belongs to, so a second write in one directory runs no rev-parse. Only resolved checkouts are kept. */
export type CheckoutMemo = Map<string, { top: string; key: string }>;

/** resolveCheckout through the session's memo: a resolved directory is answered from the memo; a null (no work tree, git failure or timeout) is not stored, so the next write retries. */
export async function memoCheckout(memo: CheckoutMemo, dir: string, platform: string = process.platform): Promise<{ top: string; key: string } | null> {
  const hit = memo.get(dir);
  if (hit) return hit;
  const c = await resolveCheckout(dir, platform);
  if (c) memo.set(dir, c);
  return c;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false; // missing, or removed between a check and this stat: not a directory
  }
}

/** The nearest existing directory above `abs` (its parent first); never throws: a path that vanishes mid-walk counts as missing. */
export function nearestDirectory(abs: string): string {
  let d = path.dirname(abs);
  while (!isDirectory(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

/** The baseline of the checkout at `top` null when git fails. */
export async function baselineAt(top: string): Promise<DirtyEntry | null> {
  const head = ((await git(top, ["rev-parse", "HEAD"])) ?? "").trim() || null; // an unborn branch has none
  const list = await dirtyPaths(top);
  if (list === null) return null;
  let paths: Record<string, string> | null = null;
  if (list.length <= MAX_BASE_PATHS) {
    paths = {};
    for (const p of list) paths[p] = await hashPath(top, p);
  }
  return { repo: top, head, paths };
}

/** The baseline of the checkout `dir` belongs to; null when git fails or `dir` is no work tree. */
export async function takeBaseline(dir: string, platform: string = process.platform): Promise<({ key: string } & DirtyEntry) | null> {
  const c = await resolveCheckout(dir, platform);
  const e = c ? await baselineAt(c.top) : null;
  return c && e ? { key: c.key, ...e } : null;
}

/** True when a recorded fingerprint and the current one prove the path unchanged: equal, and neither unreadable nor a directory digest. */
export function sameFingerprint(recorded: string, current: string): boolean {
  return recorded === current && current !== "unreadable" && !current.startsWith("dir:");
}

/** The baseline paths whose content still equals the recorded fingerprint. */
export async function unchangedSince(top: string, paths: Record<string, string>): Promise<Set<string>> {
  const same = new Set<string>();
  for (const [p, h] of Object.entries(paths)) if (sameFingerprint(h, await hashPath(top, p))) same.add(p);
  return same;
}
