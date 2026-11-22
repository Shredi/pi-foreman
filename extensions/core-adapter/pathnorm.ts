// R41 gate path normalisation: ONE function (normPath) puts a root and a candidate path into the same comparable long-name form,
// so an 8.3 short spelling (`RUNNER~1`), a different case, a `/` instead of `\` or a drive-less `/tmp` on win32 never hides a root
// match (an allow) nor a floor match (a deny). The resolver is injectable (tests stub it); POSIX keeps lexical resolution plus the
// nearest-existing-parent realpath, case-sensitive and without separator rewriting.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** realpath of an existing path, null when it does not exist. */
export type Resolver = (p: string) => string | null;

let lookups: Map<string, unknown> | null = null;

/** Run `fn` with the file-system look-ups that go through `memoLookup` answered once per path (one gate call: the file system does not change meanwhile). Nested calls share the cache. */
export function withLookupCache<T>(fn: () => T): T {
  if (lookups) return fn();
  lookups = new Map();
  try {
    return fn();
  } finally {
    lookups = null;
  }
}

/** `look()`, remembered under `key` while a `withLookupCache` scope is open. */
export function memoLookup<T>(key: string, look: () => T): T {
  if (!lookups) return look();
  if (lookups.has(key)) return lookups.get(key) as T;
  const v = look();
  lookups.set(key, v);
  return v;
}

export const nativeResolver: Resolver = (p) =>
  memoLookup(`n:${p}`, () => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  });

const px = (platform: string): typeof path.posix => (platform === "win32" ? path.win32 : path.posix);

/** `abs` with its deepest existing ancestor through `real` (8.3 names expanded by the native realpath), the missing rest appended. */
export function longForm(platform: string, abs: string, real: Resolver): string {
  const x = px(platform);
  const tail: string[] = [];
  let e = abs;
  for (;;) {
    const r = real(e);
    if (r !== null) return x.join(r, ...tail);
    const d = x.dirname(e);
    if (d === e) return abs;
    tail.unshift(x.basename(e));
    e = d;
  }
}

/**
 * The comparable form of `p`: resolved against `base` (so a drive-less `/tmp` gets the same drive as the other side), long name
 * form, and on win32 backslash separators and lower case. Both roots and candidates go through here.
 */
export function normPath(platform: string, p: string, base: string, real: Resolver = nativeResolver): string {
  const x = px(platform);
  const long = longForm(platform, x.resolve(base, p), real);
  return platform === "win32" ? long.replace(/\//g, "\\").toLowerCase() : long;
}

// ------------------------------------------------------------------ win32 8.3 short names

/** A win32 8.3 short name: up to six characters, `~N`, an optional extension of up to three. */
export const SHORT_NAME = /^[^~\\/]{1,6}~[0-9]+(\.[^\\/]{0,3})?$/i;

/**
 * Could the 8.3 short name `short` stand for `long`? Windows builds it from the long name with
 * dots and spaces removed, upper case, `+,;=[]` as `_`: the first six characters (`~1`..`~4`) or
 * two characters plus a 4-hex hash (`~5` on). The extension is not compared (more matches, never fewer).
 */
export function shortNameFits(short: string, long: string): boolean {
  const base = short.slice(0, short.indexOf("~")).toUpperCase();
  const norm = (s: string): string => s.toUpperCase().replace(/[. ]/g, "").replace(/[+,;=[\]]/g, "_");
  const lastDot = long.lastIndexOf(".");
  const forms = [norm(long), ...(lastDot > 0 ? [norm(long.slice(0, lastDot))] : [])];
  return forms.some((f) => f.length > 0 && (f.slice(0, 6) === base || (/^..[0-9A-F]{4}$/.test(base) && f.slice(0, 2) === base.slice(0, 2))));
}

/**
 * The other spellings of the win32 path `p` with each short-name segment replaced by the protected `names` it could abbreviate
 * (the original is not in the result, the separator style of `p` is kept). A short name where no protected name sits, or that fits
 * none, yields nothing; off win32 it is always empty (a file really named `CLAUDE~1` on Linux is an ordinary name).
 */
export function shortNameSpellings(platform: string, p: string, names: readonly string[]): string[] {
  if (platform !== "win32") return [];
  const segs = p.split(/[\\/]/);
  if (!segs.some((s) => SHORT_NAME.test(s))) return [];
  const sep = p.includes("\\") ? "\\" : "/";
  let variants: string[][] = [[]];
  for (const seg of segs) {
    const alts = SHORT_NAME.test(seg) ? [seg, ...names.filter((n) => shortNameFits(seg, n))] : [seg];
    variants = variants.flatMap((v) => alts.map((a) => [...v, a])).slice(0, 64);
  }
  return variants.map((v) => v.join(sep)).filter((v) => v !== p);
}

// ------------------------------------------------------------------ lexical forms (r79: the one place for slash and case rules)

/**
 * `p` with the separators of `platform` unified to `/` (win32 only: backslashes become `/`), runs of `/` collapsed (a UNC `//host` prefix
 * on win32 keeps its two slashes) and a trailing `/` cut (a root such as `/` or `c:/` keeps it). Case is untouched; see `foldCase`.
 */
export function slashForm(platform: string, p: string): string {
  const win = platform === "win32";
  let s = win ? p.replace(/\\/g, "/") : p;
  const unc = win && /^\/\/[^/]/.test(s);
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = `/${s}`;
  if (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** Case folding of a path: win32 file systems are case-insensitive, POSIX (darwin included) ones are compared as spelled. */
export function foldCase(platform: string, s: string): string {
  return platform === "win32" ? s.toLowerCase() : s;
}

/** The null device: `/dev/null` everywhere, `NUL` (any case) on win32 only (on POSIX `> NUL` creates a file). */
export function nullDevice(platform: string, target: string): boolean {
  return target === "/dev/null" || (platform === "win32" && target.toLowerCase() === "nul");
}

/** `comparable` for permission rules and floors: darwin's default file system is case-insensitive too, so it folds like win32 (the floors' own rule). */
export function comparableFs(platform: string, p: string): string {
  const s = slashForm(platform, p);
  return platform === "win32" || platform === "darwin" ? s.toLowerCase() : s;
}

/** The lexical comparable form of an absolute path: `slashForm` then `foldCase`. */
export function comparable(platform: string, p: string): string {
  return foldCase(platform, slashForm(platform, p));
}

/** Lexical containment: `p` is `root` or below it (both absolute, compared through `comparable`). */
export function lexUnder(platform: string, root: string, p: string): boolean {
  const r = comparable(platform, root);
  const c = comparable(platform, p);
  return c === r || c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * A word the shell would tilde-expand: `~` at its start or after `=` / `:` (an assignment-like word). A `~` inside a name (the 8.3 short
 * name `C:/Users/RUNNER~1/x`) is a plain character, so such a path is still a literal word.
 */
export function tildeWord(w: string): boolean {
  return /^~|[=:]~/.test(w);
}

// ------------------------------------------------------------------ the path of a Pi file tool

// Pi's UNICODE_SPACES: U+00A0, U+2000 to U+200A, U+202F, U+205F, U+3000 (built from the code points, so the source holds no invisible character)
const cp = (n: number): string => String.fromCodePoint(n);
const UNICODE_SPACES = new RegExp(`[${cp(0xa0)}${cp(0x2000)}-${cp(0x200a)}${cp(0x202f)}${cp(0x205f)}${cp(0x3000)}]`, "g");

/** Pi's `normalizeWindowsShellPath` (dist/utils/paths.js): a Git Bash, MSYS, Cygwin or WSL drive path as a Windows path. */
function winShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  return m ? `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}` : p;
}

/** The steps of Pi's `normalizePath` in its order: unicode spaces, one leading `@`, win32 drive spellings, `~` and `~/`, `file://`. Throws where Pi's function throws. */
function piNormalize(input: string, home: string, platform: string, spacesAndAt: boolean): string {
  let n = input;
  if (spacesAndAt) n = n.replace(UNICODE_SPACES, " ");
  if (spacesAndAt && n.startsWith("@")) n = n.slice(1);
  if (platform === "win32") n = winShellPath(n);
  if (n === "~") return home;
  if (n.startsWith("~/") || (platform === "win32" && n.startsWith("~\\"))) return px(platform).join(home, n.slice(2));
  if (n.startsWith("file://")) return fileURLToPath(n);
  return n;
}

/**
 * The absolute path Pi's write, edit, read, ls, grep and find tools act on for `raw` run in `cwd`: `resolveToCwd` of dist/core/tools/path-utils.js, that is
 * `resolvePath(raw, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true })` of dist/utils/paths.js (the cwd goes through `normalizePath` with its defaults).
 * null where Pi's function throws (a malformed `file://`): the caller denies the call.
 */
export function toolPath(raw: string, cwd: string, home: string, platform: string): string | null {
  try {
    const n = piNormalize(raw, home, platform, true);
    const x = px(platform);
    return x.isAbsolute(n) ? x.resolve(n) : x.resolve(piNormalize(cwd, home, platform, false), n);
  } catch {
    return null;
  }
}

/** `p` is `root` or below it, both normalised with `normPath`. */
export function sameOrUnder(platform: string, root: string, p: string, base: string, real: Resolver = nativeResolver): boolean {
  const r = normPath(platform, root, base, real);
  const c = normPath(platform, p, base, real);
  const sep = px(platform).sep;
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}
