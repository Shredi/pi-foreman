// Images in a pull request (docs/tools.md, pr_create `attach` and pr_attach): the checks that run before any image leaves the machine.
//   - the entries: at most ATTACH_MAX paths, an optional one-line caption each, no `#` or line break (gh splits `path#caption` at the first `#`);
//   - the files: a still image (png, jpg, jpeg, webp) that is a regular non-empty file whose real path lies inside the git toplevel of the PR's checkout;
//     animated images (APNG, animated WebP), GIF and video are refused, because the reviewer sees one frame only;
//   - the review: an image goes out only when the newest code review of the PR's head, in that checkout, is a `[pre-pr]` PASS whose `attach` list holds the
//     file with the sha256 it has now (the adapter records the list at the reviewer's verdict, index.ts).
// A model-facing refusal is a plain text with a `[pr_refused:<reason>]` or `[attach_<reason>]` tag; the host call is made by scripts/pr_ops.py.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { rootHolds, under } from "./pathrules.ts";
import type { ReviewRecord } from "./reviews.ts";

/** An image the reviewer passed: the path relative to the git toplevel of the checkout (`/` separators) and its sha256 (hex). */
export interface AttachRef {
  path: string;
  sha256: string;
}

export interface AttachEntry {
  path: string;
  caption?: string;
}

/** A checked image file. `abs` is the real path that was read and hashed. */
export interface AttachFile extends AttachRef {
  abs: string;
  caption?: string;
}

export const ATTACH_MAX = 10;
export const CAPTION_MAX = 200;
const PATH_MAX = 1000;
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"] as const;

export type AttachReason = "attach_invalid" | "attach_outside" | "attach_type" | "attach_missing";
export type AttachProblem = { reason: AttachReason; message: string };

const problem = (reason: AttachReason, why: string): AttachProblem => ({ reason, message: `attach refused [${reason}]: ${why}` });

const oneLine = (s: string): boolean => !/[\r\n\u0085\u2028\u2029\0]/.test(s);

/** The entries of an `attach` argument: 1 to ATTACH_MAX objects `{path, caption?}` (a plain string is a path without caption). */
export function parseAttachEntries(raw: unknown): { entries: AttachEntry[] } | AttachProblem {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ATTACH_MAX) return problem("attach_invalid", `attach is a list of 1 to ${ATTACH_MAX} entries {path, caption?}`);
  const entries: AttachEntry[] = [];
  for (const x of raw as unknown[]) {
    const o = typeof x === "string" ? { path: x } : x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    if (!o || Object.keys(o).some((k) => k !== "path" && k !== "caption")) return problem("attach_invalid", "each attach entry is {path, caption?}");
    if (typeof o.path !== "string" || o.path === "" || o.path.length > PATH_MAX) return problem("attach_invalid", `an attach path is a string of 1 to ${PATH_MAX} characters`);
    if (o.path.includes("#") || !oneLine(o.path)) return problem("attach_invalid", `the path ${JSON.stringify(o.path.slice(0, 80))} has a # or a line break (gh reads path#caption)`);
    if (o.caption !== undefined) {
      if (typeof o.caption !== "string" || o.caption.length > CAPTION_MAX || o.caption.includes("#") || !oneLine(o.caption)) return problem("attach_invalid", `a caption is one line of at most ${CAPTION_MAX} characters without #`);
    }
    const caption = typeof o.caption === "string" ? o.caption.trim() : "";
    entries.push({ path: o.path, ...(caption ? { caption } : {}) });
  }
  return { entries };
}

/** The `attach` list of a reviewer launch: strings only (a caption has no use there), same limits. */
export function parseAttachPaths(raw: unknown): { entries: AttachEntry[] } | AttachProblem {
  if (Array.isArray(raw) && raw.some((x) => typeof x !== "string")) return problem("attach_invalid", "the launch field attach is a list of paths (strings)");
  return parseAttachEntries(raw);
}

/** The value of one `--attach=` argument of gh: `path` or `path#caption`. */
export const attachArg = (f: { path: string; caption?: string }): string => (f.caption ? `${f.path}#${f.caption}` : f.path);

/** Why `buf` is no still image of the kind `ext` names (null: it is one). Reads the magic bytes and the animation marks only. */
export function stillImageProblem(buf: Buffer, ext: string): string | null {
  if (ext === ".png") {
    if (buf.length < 8 || buf.compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0, 8, 0, 8) !== 0) return "the content is not a PNG";
    for (let off = 8; off + 8 <= buf.length; ) {
      const type = buf.toString("latin1", off + 4, off + 8);
      if (type === "acTL") return "an animated PNG (the reviewer sees only the first frame)";
      if (type === "IDAT" || type === "IEND") break;
      off += 12 + buf.readUInt32BE(off);
    }
    return null;
  }
  if (ext === ".jpg" || ext === ".jpeg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? null : "the content is not a JPEG";
  if (ext === ".webp") {
    if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return "the content is not a WebP";
    for (let off = 12; off + 8 <= buf.length; ) {
      const type = buf.toString("latin1", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (type === "ANIM") return "an animated WebP (the reviewer sees only the first frame)";
      if (type === "VP8X" && off + 9 <= buf.length && (buf[off + 8] & 0x02) !== 0) return "an animated WebP (the reviewer sees only the first frame)";
      off += 8 + size + (size % 2);
    }
    return null;
  }
  return "not a still image type";
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** One entry against the checkout `top` (a realpath): the checked file, or why it is refused. */
function checkOne(e: AttachEntry, top: string, platform: string): AttachFile | AttachProblem {
  const shown = JSON.stringify(e.path.length > 80 ? `${e.path.slice(0, 80)}...` : e.path);
  const lex = path.resolve(top, e.path);
  let real: string;
  try {
    real = fs.realpathSync.native(lex);
  } catch {
    return problem("attach_missing", `${shown} does not exist`);
  }
  if (!rootHolds(top, lex, platform) || !rootHolds(top, real, platform)) return problem("attach_outside", `${shown} is not inside the checkout ${top} (symbolic links are followed); copy the image into the checkout (for example .workflow/screenshots/) first`);
  const ext = path.extname(lex).toLowerCase();
  if (!(IMAGE_EXTS as readonly string[]).includes(ext)) return problem("attach_type", `${shown} is not a still image (${IMAGE_EXTS.join(", ")}); GIF and video are refused because the reviewer cannot look at them`);
  let buf: Buffer;
  try {
    if (!fs.statSync(real).isFile()) return problem("attach_type", `${shown} is not a regular file`);
    buf = fs.readFileSync(real);
  } catch {
    return problem("attach_missing", `${shown} cannot be read`);
  }
  if (buf.length === 0) return problem("attach_type", `${shown} is empty`);
  const bad = stillImageProblem(buf, ext);
  if (bad) return problem("attach_type", `${shown}: ${bad}`);
  const rel = path.relative(top, under(platform, top, lex) ? lex : real).split(path.sep).join("/");
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return problem("attach_outside", `${shown} is not inside the checkout ${top}`);
  return { path: rel, sha256: sha256(buf), abs: real, ...(e.caption ? { caption: e.caption } : {}) };
}

/** The files of `entries` checked against the checkout `top` (the realpath of its git toplevel): all of them, or the first refusal. Duplicates (one real file twice) are refused. */
export function checkAttach(entries: readonly AttachEntry[], top: string, platform: string = process.platform): { files: AttachFile[] } | AttachProblem {
  const files: AttachFile[] = [];
  for (const e of entries) {
    const f = checkOne(e, top, platform);
    if ("reason" in f) return f;
    if (files.some((x) => x.abs === f.abs)) return problem("attach_invalid", `${JSON.stringify(f.path)} is listed twice`);
    files.push(f);
  }
  return { files };
}

/** The refs of `refs` whose file still has the recorded sha256 (checked again like a new file); `dropped` names the others. */
export function rehashAttach(refs: readonly AttachRef[], top: string, platform: string = process.platform): { kept: AttachRef[]; dropped: string[] } {
  const kept: AttachRef[] = [];
  const dropped: string[] = [];
  for (const r of refs) {
    const f = checkOne({ path: r.path }, top, platform);
    if ("reason" in f || f.sha256 !== r.sha256 || f.path !== r.path) dropped.push(r.path);
    else kept.push({ path: r.path, sha256: r.sha256 });
  }
  return { kept, dropped };
}

/** `attach` of a persisted record or route, validated field by field (a bad list is dropped whole). */
export function attachRefsOf(v: unknown): AttachRef[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > ATTACH_MAX) return undefined;
  const out: AttachRef[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") return undefined;
    const { path: p, sha256: h } = x as Record<string, unknown>;
    if (typeof p !== "string" || p === "" || p.length > PATH_MAX || typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return undefined;
    out.push({ path: p, sha256: h });
  }
  return out;
}

/** The block a `[pre-pr]` reviewer task gets for its attach list. */
export function attachTaskBlock(files: readonly AttachFile[]): string {
  return [
    "Images to attach to the pull request (your PASS releases exactly these files, as they are now):",
    ...files.map((f) => `- ${f.abs}`),
    "Open each one with `read` and look at it. FAIL the review when an image shows private data: host names, IP addresses, personal home paths, customer or employer names, keys or tokens, e-mail addresses other than the commit author's.",
  ].join("\n");
}

/** gh uploads `--attach` files to github.com and to GitHub Enterprise Cloud (`*.ghe.com`); a self-hosted server does not support it. */
export function githubUploadHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "github.com" || h.endsWith(".ghe.com");
}

/**
 * The review test of an attach list: the newest code review recorded for `head` in the checkout `top` must be a `[pre-pr]` PASS whose `attach` holds every file
 * with the sha256 it has now. It applies whatever ceremony.reviewBeforePr says, and also when the upload would degrade.
 */
export function attachRefusal(tool: string, records: readonly ReviewRecord[], top: string, head: string | null, files: readonly AttachRef[], platform: string = process.platform): { reason: "attach_unreviewed"; message: string } | null {
  const newest = head ? records.findLast((r) => r.kind !== "plan" && r.head === head && r.cwd !== undefined && under(platform, r.cwd, top) && under(platform, top, r.cwd)) : undefined;
  const held = newest && newest.verdict === "pass" && newest.occasion === "pre-pr" ? (newest.attach ?? []) : [];
  const open = files.filter((f) => !held.some((a) => a.path === f.path && a.sha256 === f.sha256)).map((f) => f.path);
  if (open.length === 0) return null;
  return { reason: "attach_unreviewed", message: `pi-foreman: ${tool} refused [pr_refused:attach_unreviewed] ${open.join(", ")}: run a [pre-pr] reviewer with attach naming them (the newest review of this head must be that PASS and the files unchanged since; the check applies even when nothing would be uploaded). Nothing was done.` };
}
