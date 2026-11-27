// Fast allow of the gate-verify plan (D2): what runs with no judge call besides the read set of effects.ts.
// List B is skip-only: a program that reads or only reports, in the forms its option table names. Any other option or form is not classified (fail closed).
// A glob operand of a read program inside the folder the line runs in is a read operand; so is a here-document fed to one.
import { LIST_READ } from "./effects.ts";
import type { ShellSegment } from "./shellast.ts";

const NUM = /^\d+(\.\d+)?[smhd]?$/;
const SAFE_VALUE = /^[A-Za-z0-9,_=:.%+@/-]+$/;
const INT = /^\d+$/;

/** One option cluster `-abc` of `flags`; `valued` letters take a value (the rest of the word, or the next word). Returns how many words it used, or 0 when the word is not such a cluster. */
function cluster(argv: string[], i: number, flags: string, valued: string, value: RegExp): number {
  const w = argv[i];
  if (!/^-[A-Za-z]+$/.test(w)) return 0;
  for (let k = 1; k < w.length; k++) {
    const ch = w[k];
    if (flags.includes(ch)) continue;
    if (!valued.includes(ch)) return 0;
    const attached = w.slice(k + 1);
    if (attached) return value.test(attached) ? 1 : 0;
    return argv[i + 1] !== undefined && value.test(argv[i + 1]) ? 2 : 0;
  }
  return 1;
}

const MODE = /^(?:[0-7]{1,4}|[ugoa]*[-+=][rwxXst]*(?:,[ugoa]*[-+=][rwxXst]*)*)$/;

/** How many words of `mkdir`'s `argv` the option at `i` uses when it is a mode option (`-m 700`, `-m700`, `-pm 700`, `--mode 700`, `--mode=700`), else 0. */
export function mkdirModeWords(argv: string[], i: number): number {
  const w = argv[i];
  if (w === "--mode") return argv[i + 1] !== undefined ? 2 : 0;
  if (w.startsWith("--mode=")) return 1;
  return /^-[A-Za-z]*m/.test(w) ? cluster(argv, i, "pv", "m", MODE) : 0;
}

/** Walks `argv` with `step` (words used, 0 = refused); the operands come back through `operand`. */
function walk(argv: string[], step: (i: number) => number, operand: (w: string) => boolean): boolean {
  let opts = true;
  for (let i = 0; i < argv.length; ) {
    const w = argv[i];
    if (opts && w === "--") {
      opts = false;
      i++;
    } else if (opts && w.startsWith("-") && w !== "-") {
      const n = step(i);
      if (n === 0) return false;
      i += n;
    } else {
      if (!operand(w)) return false;
      i++;
    }
  }
  return true;
}

const plain = (w: string): boolean => !w.startsWith("-") || w === "-";

const TABLE: Record<string, (argv: string[]) => boolean> = {
  sleep: (a) => a.length === 1 && NUM.test(a[0]),
  uptime: (a) => a.length === 0,
  // `date` prints; every other form (`-s`, `-d`, `--set`) is not listed
  date: (a) => a.every((w) => w.startsWith("+") || /^-(u|R|I(date|hours|minutes|seconds|ns)?)$/.test(w)),
  // `ps` and `pgrep` report; a signal (`-9`, `-HUP`) is none of their options
  ps: (a) => walk(a, (i) => cluster(a, i, "aAdeEfFhHlLmMNrTvVwxXyZc", "oOpPuUCtGgs", SAFE_VALUE), (w) => /^[A-Za-z]+$/.test(w) || SAFE_VALUE.test(w)),
  pgrep: (a) => walk(a, (i) => cluster(a, i, "aflinovxwcL", "dgGPstuUFr", SAFE_VALUE), (w) => !w.startsWith("-")),
  sort: (a) => walk(a, (i) => cluster(a, i, "nrufhVsb", "kt", /^[0-9A-Za-z,.]+$/), plain),
  uniq: (a) => {
    let operands = 0;
    return walk(a, (i) => cluster(a, i, "cdiu", "fsw", INT), (w) => plain(w) && ++operands <= 1);
  },
};

/** The List B programs. */
export const SKIP_ONLY: ReadonlySet<string> = new Set(Object.keys(TABLE));

/** A List B program in a form its table lists: the call only reads or reports. */
export function skipOnlyOk(prog: string, argv: string[]): boolean {
  return Object.hasOwn(TABLE, prog) && TABLE[prog](argv);
}

const PS_PROGRAMS: ReadonlySet<string> = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
/** The characters a `-Command` line may not hold: separators, pipes, redirects, grouping, variables, quotes, splatting and list commas. */
const PS_BAD_LINE = /[;|&<>(){}$`'"@,\n\r]/;
/** A FileSystem drive path (`X:\\…`, `X:/…`, no further `:`) or a relative path with no `:` that is no UNC path (`\\\\`, `//`). */
const PS_DRIVE_PATH = /^[A-Za-z]:[\\/][^:]*$/;
function psFileSystemPath(p: string): boolean {
  if (p === "" || p.startsWith("-") || /^[\\/]{2}/.test(p)) return false;
  return PS_DRIVE_PATH.test(p) || !p.includes(":");
}

/**
 * Skip-only: `powershell|pwsh [.exe] -NoProfile [-NonInteractive] -Command <line>` where the line is one of `Get-Volume`, `Get-PSDrive [-PSProvider FileSystem]` or
 * `Get-ChildItem` with `-Recurse -File -Directory -Force` and one path without `*`, `?` or `[` (`-Path <p>` or positional): a drive path or a relative path of the FileSystem provider that
 * `secret` does not name. Without `-NoProfile` PowerShell runs the user's profile script, so it is required. Anything else is no skip-only form (the judge looks).
 * Reads no cmdlet knowledge from the line beyond this table; the segment must be the whole foreign-shell unit (no wrapper, redirect or here-document).
 */
export function psSkipOnlyOk(seg: ShellSegment, secret: (path: string) => boolean): boolean {
  if (seg.opaque !== "foreign_shell" || !PS_PROGRAMS.has(seg.program) || seg.wrappers.length > 0 || seg.redirects.length > 0 || seg.heredoc) return false;
  const a = seg.argv;
  const cmd = a.findIndex((w) => w.toLowerCase() === "-command");
  if (cmd < 0 || cmd === a.length - 1) return false;
  const opts = a.slice(0, cmd).map((w) => w.toLowerCase());
  if (!opts.includes("-noprofile") || opts.some((w, i) => (w !== "-noprofile" && w !== "-noninteractive") || opts.indexOf(w) !== i)) return false;
  const line = a.slice(cmd + 1).join(" ");
  if (PS_BAD_LINE.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  const name = words[0]?.toLowerCase();
  const rest = words.slice(1);
  if (name === "get-volume") return rest.length === 0;
  if (name === "get-psdrive") return rest.length === 0 || (rest.length === 2 && rest[0].toLowerCase() === "-psprovider" && rest[1].toLowerCase() === "filesystem");
  if (name !== "get-childitem") return false;
  const seen = new Set<string>();
  let target: string | null = null;
  const take = (p: string): boolean => {
    if (target !== null || /[*?[]/.test(p) || !psFileSystemPath(p) || secret(p) || secret(p.replace(/\\/g, "/"))) return false;
    target = p;
    return true;
  };
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const k = w.toLowerCase();
    if (k === "-recurse" || k === "-file" || k === "-directory" || k === "-force") {
      if (seen.has(k)) return false;
      seen.add(k);
    } else if (k === "-path") {
      if (i + 1 >= rest.length || !take(rest[++i])) return false;
    } else if (w.startsWith("-") || !take(w)) return false;
  }
  return true;
}

/** Read programs whose options can write or run a program (a file named `-o` or `--pre=x` in the folder would be read as one): a glob that may expand to such a name is no operand of theirs. */
const OPTION_PROGRAMS = new Set(["rg", "tree", "diff", "file", "find", "sort", "uniq"]);
const GLOB_WORD = /^[A-Za-z0-9_.@%+,/*?[\]-]+$/;

/**
 * The glob operands of a read program inside the folder it runs in: every word the walk found not literal is a plain glob (no variable, substitution, brace, quote or `~` in it),
 * relative, without `..`; a program whose options write or run something takes one only where the glob cannot start with a wildcard (`*` may expand to `-o`).
 */
export function readGlobSegment(seg: ShellSegment): boolean {
  if (seg.opaque !== "glob_target" || !LIST_READ.has(seg.program) || !seg.dynamicArgs?.length) return false;
  return seg.dynamicArgs.every((i) => {
    const w = seg.argv[i];
    if (w === undefined || !GLOB_WORD.test(w) || !/[*?[]/.test(w) || w.startsWith("/") || w.startsWith("-") || w.split("/").includes("..")) return false;
    return !(/^[*?[]/.test(w) && OPTION_PROGRAMS.has(seg.program));
  });
}
