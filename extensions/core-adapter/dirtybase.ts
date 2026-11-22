// Per-checkout baseline of a session (ledger session-own-changes): which paths of a checkout were already changed when the
// session first worked there, each with a fingerprint of its content. The trivial finish check, the "unreviewed work"
// reminder and the close report (scripts/foreman_close.py, same hash spec) count only what differs from it.
//
// Hash spec (shared with foreman_close.py, same test vectors):
//   missing path            "deleted"        (lstat fails with ENOENT)      unreadable file  "unreadable"
//   symlink                 "link:" + sha256(readlink text, utf-8)[:16]
//   directory               "dir:" + sha256(HEAD (trimmed, "" when none) + "\n" + `git status --porcelain=v1 -z --untracked-files=all` inside it)[:16]
//   regular file            sha256(bytes)[:16]; over 64 MiB "big:" + size + ":" + (mtime in ns // 1_000_000)
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
  } catch {
    return "deleted";
  }
  try {
    if (st.isSymbolicLink()) return `link:${sha16(Buffer.from(await fs.promises.readlink(p), "utf8"))}`;
    if (st.isDirectory()) {
      const head = ((await git(p, ["rev-parse", "HEAD"])) ?? "").trim();
      const status = (await git(p, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) ?? "";
      return dirDigest(head, status);
    }
    if (st.size > BigInt(BIG_FILE)) return `big:${st.size}:${st.mtimeNs / 1000000n}`;
    return sha16(await fs.promises.readFile(p));
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

/** The baseline paths whose content still equals the recorded fingerprint. */
export async function unchangedSince(top: string, paths: Record<string, string>): Promise<Set<string>> {
  const same = new Set<string>();
  for (const [p, h] of Object.entries(paths)) if ((await hashPath(top, p)) === h) same.add(p);
  return same;
}
