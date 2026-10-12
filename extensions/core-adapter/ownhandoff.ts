// "own-handoff" deterministic allow (R3b point 8b): a chain segment that is `mkdir`, `cp`, `cat` or `ls`
// and writes or reads only below the session's own handoff dirs (owned.ts ownHandoffDirs) or its round
// worktree. The permission system asks for each of these under the catch-all `*` rule, and the shell write
// guard treats a bare `*` target as dynamic, so the foreman was asked again and again for its own files.
//
// Narrow on purpose: fixed flags (no recursion, no -t/-T/-L), no redirects, no `$`, `~` or `..`, a glob only as
// a trailing `<dir>/*` on a read (the `"cp"` destination excluded), write operands contained in the two roots (symlinks resolved, never below
// `.git`), and never a handoff dir's `parent` or `child` file (the close check and the ask contract read them).
import * as path from "node:path";
import { contained } from "./effects.ts";
import type { EffectCtx } from "./effects.ts";
import type { Segment } from "./shellchain.ts";

/** Flags per verb: letters only, no value options. */
const FLAGS: Record<string, RegExp> = {
  mkdir: /^-[pv]+$/,
  cp: /^-[fpnv]+$/,
  cat: /^-n$/,
  ls: /^-[alh1d]+$/,
};

const GUARDED = new Set(["parent", "child"]);

/** splitChain refuses an unquoted `*`; a trailing `<dir>/*` word is swapped for `<dir>/<GLOB>` before the split and read as "every file in <dir>". */
const GLOB = "__own_glob__";
const TRAILING_GLOB = /(^|[\s;&|])((?:\/|\.\/)?[A-Za-z0-9_.,:@%+=^/-]*[A-Za-z0-9_.-])\/\*(?=$|[\s;&|])/g;

export const hasGlobSentinel = (text: string): boolean => text.includes(GLOB);

export function withGlobSentinel(command: string): string {
  return command.replace(TRAILING_GLOB, (_m, lead: string, dir: string) => `${lead}${dir}/${GLOB}`);
}

function plainWord(w: string): boolean {
  return w.length > 0 && !/[$`~\\*?[\]{}!#]/.test(w) && !w.split("/").includes("..");
}

/** `dir/*` -> `dir` (a trailing glob on a read), a plain word -> itself, anything else null. */
function readOperand(w: string): string | null {
  if (w.endsWith(`/${GLOB}`)) {
    const dir = w.slice(0, -GLOB.length - 1);
    return plainWord(dir) ? dir : null;
  }
  return plainWord(w) ? w : null;
}

/** True when the segment is one of the verbs above and every operand stays in `own` (handoff dirs) or the worktree root. */
export function ownHandoffSegment(c: EffectCtx, own: string[], cwd: string | null, seg: Segment): boolean {
  if (!own.length || seg.redirects.length) return false;
  const verb = seg.words[0];
  const flags = FLAGS[verb];
  if (!flags) return false;
  const rest = seg.words.slice(1);
  const ops = rest.filter((w) => !w.startsWith("-"));
  if (!rest.filter((w) => w.startsWith("-")).every((w) => flags.test(w)) || !ops.length) return false;
  const roots = [...own, ...(c.root ? [c.root] : [])];
  const x = c.platform === "win32" ? path.win32 : path.posix;
  const fold = (s: string): string => (c.platform === "win32" || c.platform === "darwin" ? s.toLowerCase() : s);
  const guarded = (w: string): boolean => {
    if (cwd === null) return true;
    const abs = x.resolve(cwd, w);
    return GUARDED.has(fold(x.basename(abs))) && own.some((d) => fold(x.resolve(d)) === fold(x.dirname(abs)));
  };
  const writeOk = (w: string): boolean => plainWord(w) && !w.endsWith(GLOB) && !guarded(w) && contained(c, cwd, w, true, roots);
  const readOk = (w: string): boolean => {
    const r = readOperand(w);
    return r !== null && (contained(c, cwd, r, false, roots) || contained(c, cwd, r, false));
  };
  if (verb === "mkdir") return ops.every(writeOk);
  if (verb === "cp") {
    if (ops.length < 2) return false;
    const dest = ops[ops.length - 1];
    const srcs = ops.slice(0, -1);
    // a copy into a directory writes `dest/<source name>`: a guarded name must not come out of that
    if (!writeOk(dest) || srcs.some((s) => guarded(`${dest}/${x.basename(s)}`))) return false;
    return srcs.every(readOk);
  }
  return ops.every(readOk);
}
