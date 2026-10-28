// R41 gate path normalisation: ONE function (normPath) puts a root and a candidate path into the same comparable long-name form,
// so an 8.3 short spelling (`RUNNER~1`), a different case, a `/` instead of `\` or a drive-less `/tmp` on win32 never hides a root
// match (an allow) nor a floor match (a deny). The resolver is injectable (tests stub it); POSIX keeps lexical resolution plus the
// nearest-existing-parent realpath, case-sensitive and without separator rewriting.
import * as fs from "node:fs";
import * as path from "node:path";

/** realpath of an existing path, null when it does not exist. */
export type Resolver = (p: string) => string | null;

export const nativeResolver: Resolver = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

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

/** `p` is `root` or below it, both normalised with `normPath`. */
export function sameOrUnder(platform: string, root: string, p: string, base: string, real: Resolver = nativeResolver): boolean {
  const r = normPath(platform, root, base, real);
  const c = normPath(platform, p, base, real);
  const sep = px(platform).sep;
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}
