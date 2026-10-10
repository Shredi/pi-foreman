// Effect classes for a child's bash ask (ladder-polish item 8, docs/permissions.md). `classify`
// sorts a command by what it does, not by a name list:
//   read        ls cat head tail wc stat file tree diff grep rg find, print-only sed, read-only git
//               (status log diff show; add/clean/mv/rm only with -n/--dry-run), npm/cargo/make dry runs
//   build-test  the project's own test/build commands, taken from its manifest at the worktree root
//               (package.json scripts test/build/lint, Makefile test targets, Cargo.toml, go.mod,
//               pytest config) and run from that root
//   write-in    mkdir touch cp mv rm tee, `sed -i` with one plain s/// script, the test restore
//   write-out   one of those writes (or a redirect) that reaches outside the allowed places
//   unknown     everything else, and anything the chain splitter (shellchain.ts) refuses
// Every path argument of a read or a write must resolve inside the worktree (git top level of the
// cwd), a live $FOREMAN_SCRATCH dir of the asking role, or /tmp (POSIX), and for reads also a
// safety.permissions.readRoots dir: no `~`, no `..`, no drive-relative `C:x`, and the realpath of
// the nearest existing ancestor must stay inside (no symlink out). Writes must lie strictly below
// such a place and never under `.git`. A chain takes the class of its worst segment; `cd <dir>`
// moves the cwd the later segments resolve against; a path under an earlier segment's write
// destination is unknown (ChainWrites).
// Only write-out and unknown go on to the model review (timeoutallow.ts composes the allow).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isTestPath } from "./diffscan.ts";
import { workspaceTop } from "./gitdrift.ts";
import { insideScratch, expandScratchVar } from "./childscratch.ts";
import { isReadOnlySed } from "./sedread.ts";
import { splitChain } from "./shellchain.ts";
import type { Redirect, Segment } from "./shellchain.ts";
import { tmpDest } from "./tmpscratch.ts";
import { unwrapTimeout } from "./timeoutallow.ts";

export type EffectClass = "read" | "build-test" | "write-in" | "write-out" | "unknown";

export interface EffectCtx {
  /** The asking process's cwd (a child runs in the foreman's cwd). */
  cwd: string;
  /** Git top level of the cwd; null outside a repo (then only scratch and /tmp count). */
  root: string | null;
  scratch?: string[];
  /** safety.permissions.readRoots as real absolute dirs (readRootsOf): extra places for reads only. */
  readRoots?: string[];
  platform?: string;
  /** Injectable for tests: realpath of an existing path, lstat existence, a file below root. */
  realpath?: (p: string) => string | null;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | null;
}

export function effectCtx(cwd: string, scratch: string[] = [], platform: string = process.platform, readRoots: unknown = []): EffectCtx {
  return { cwd: path.resolve(cwd), root: workspaceTop(cwd), scratch, platform, readRoots: readRootsOf(readRoots, platform) };
}

/** Programs that run other commands or change who/how they run: the whole command is refused. */
const RUNNERS = new Set(["eval", "exec", "source", ".", "xargs", "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "sudo", "doas", "su", "nohup", "nice", "ionice", "time", "command", "builtin", "stdbuf", "setsid", "chroot", "script", "watch", "parallel", "busybox", "pwsh", "powershell", "cmd", "unbuffer", "trap"]);

/** True when `words` must not be judged deterministically at all (a runner or an `X=y` prefix). */
export function refusedProgram(words: string[]): boolean {
  const w = words[0] ?? "";
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || RUNNERS.has(w.replace(/^.*\//, "").toLowerCase());
}

const RANK: Record<EffectClass, number> = { read: 0, "build-test": 1, "write-in": 2, "write-out": 3, unknown: 4 };
export const SAFE_CLASSES: readonly EffectClass[] = ["read", "build-test", "write-in"];

// ------------------------------------------------------------------ paths

const realDefault = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};
const existsDefault = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** safety.permissions.readRoots as real absolute dirs: `~` and `%USERPROFILE%` mean the home dir; empty, relative or missing roots are dropped. */
export function readRootsOf(roots: unknown, platform: string = process.platform, real: (p: string) => string | null = realDefault, home: string = os.homedir()): string[] {
  if (!Array.isArray(roots)) return [];
  const x = platform === "win32" ? path.win32 : path.posix;
  const out: string[] = [];
  for (const r of roots) {
    if (typeof r !== "string" || !r.trim()) continue;
    let p = r.trim().replace(/^%USERPROFILE%(?=$|[\\/])/i, home);
    if (p === "~" || /^~[\\/]/.test(p)) p = home + p.slice(1);
    if (!x.isAbsolute(p) || (platform === "win32" && !/^([A-Za-z]:[\\/]|\\\\)/.test(p))) continue;
    const rp = real(x.resolve(p));
    if (rp) out.push(rp);
  }
  return out;
}

const plat = (c: EffectCtx): string => c.platform ?? process.platform;
const px = (c: EffectCtx): path.PlatformPath => (plat(c) === "win32" ? path.win32 : path.posix);
const fold = (c: EffectCtx, s: string): string => (plat(c) === "win32" || plat(c) === "darwin" ? s.toLowerCase() : s);

/** `p` lies inside `base` (equal allowed unless `strict`), same drive. */
function within(c: EffectCtx, base: string, p: string, strict: boolean): boolean {
  const x = px(c);
  const rel = x.relative(fold(c, x.resolve(base)), fold(c, x.resolve(p)));
  if (rel === "") return !strict;
  return rel !== ".." && !rel.startsWith(".." + x.sep) && !x.isAbsolute(rel);
}

/** A path component that is or may alias `.git`: on win32 also an 8.3 short name (`GIT~1`) or a trailing dot or space (`.git.`). */
function gitAlias(c: EffectCtx, part: string): boolean {
  return fold(c, part) === ".git" || (plat(c) === "win32" && (/[. ]$/.test(part) || /~\d/.test(part)));
}
const hasGitPart = (c: EffectCtx, rel: string): boolean => rel.split(/[\\/]/).some((p) => gitAlias(c, p));

/** The deepest existing ancestor of `abs` (itself included) resolves inside realpath(base); with `noGit` not under its `.git` either. */
function realInside(c: EffectCtx, base: string, abs: string, strict: boolean, noGit = false): boolean {
  const x = px(c);
  const real = c.realpath ?? realDefault;
  const exists = c.exists ?? existsDefault;
  const rb = real(base);
  if (!rb) return false;
  let e = abs;
  while (!exists(e)) {
    if (!within(c, base, e, true)) return false;
    e = x.dirname(e);
  }
  const r = real(e);
  if (!r) return false;
  if (noGit && hasGitPart(c, x.relative(rb, r))) return false;
  return within(c, rb, r, strict && e === abs);
}

/** `word` as an absolute path against `cwd`, or null for `~`, `..`, drive-relative or an unknown cwd. */
function resolveWord(c: EffectCtx, cwd: string | null, word: string): string | null {
  // bash expands `~` after `=` or `:` too (`a=~/x`, `--file=~/x`)
  if (cwd === null || !word || word.startsWith("~") || /[=:]~/.test(word)) return null;
  if (plat(c) === "win32" && /^[A-Za-z]:(?![\\/])/.test(word)) return null;
  if (word.split(/[\\/]/).includes("..")) return null;
  return px(c).resolve(cwd, word);
}

function bases(c: EffectCtx, write: boolean): string[] {
  return [...(c.root ? [c.root] : []), ...(c.scratch ?? []), ...(plat(c) === "win32" ? [] : ["/tmp"]), ...(write ? [] : (c.readRoots ?? []))];
}

/** A read (`write` false) or write path inside the worktree, a scratch dir or /tmp (see the header). */
export function contained(c: EffectCtx, cwd: string | null, word: string, write: boolean, only?: string[]): boolean {
  const abs = resolveWord(c, cwd, word);
  if (!abs) return false;
  const x = px(c);
  for (const b of only ?? bases(c, write)) {
    if (!within(c, b, abs, write)) continue;
    if (write && hasGitPart(c, x.relative(x.resolve(b), abs))) return false;
    if (realInside(c, b, abs, write, write)) return true;
  }
  return false;
}

/** Options that name a program to run (`rg --hostname-bin`, `go test -exec`, `npm --script-shell`, `--*-command`, `--exec*`). */
const PROGRAM_OPT = /^--?([\w-]*-command|exec[\w-]*|toolexec|hostname-bin|pre|script-shell)(=|$)/;

/** An option word: `--x=value` checks the value as a path; a bare option must not hold a path or name a program. */
function optionOk(c: EffectCtx, cwd: string | null, w: string, write: boolean): boolean {
  if (PROGRAM_OPT.test(w)) return false;
  const eq = w.indexOf("=");
  if (eq >= 0) {
    const v = w.slice(eq + 1);
    return v === "" || contained(c, cwd, v, write);
  }
  return !/[\\/]/.test(w);
}

/** Every option and operand of `args` passes (operands as read paths); `skip` operand indexes are not paths. */
function argsOk(c: EffectCtx, cwd: string | null, args: string[], skip: Set<number> = new Set()): boolean {
  let opts = true;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (opts && a === "--") opts = false;
    else if (opts && a.startsWith("-") && a !== "-") {
      if (!optionOk(c, cwd, a, false)) return false;
    } else if (a !== "-" && !skip.has(k) && !contained(c, cwd, a, false)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ segments

export interface SegmentEffect {
  cls: EffectClass;
  /** True when the class is authoritative; false lets the permission rules decide (an unknown program). */
  known: boolean;
  /** Deterministic label for a safe class: sed-read, test-restore, effect-<class>, cd. */
  label?: string;
  /** The cwd for the following segments. */
  cwd: string | null;
  /** The command text without a `timeout N` wrapper, for the permission rules. */
  unit: string;
  wrapped?: boolean;
}

const READ = new Set(["ls", "cat", "head", "tail", "wc", "stat", "file", "tree", "diff", "grep", "egrep", "fgrep", "rg", "find"]);
const FIND_BAD = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-L", "-H", "-follow"]);

function shortHas(a: string, ch: string): boolean {
  return /^-[A-Za-z0-9]+$/.test(a) && a.slice(1).includes(ch);
}

function readVerb(c: EffectCtx, cwd: string | null, prog: string, args: string[]): boolean {
  const opts = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  if (prog === "find" && args.some((a) => FIND_BAD.has(a))) return false;
  if (prog === "rg" && opts.some((a) => /^--(pre|pre-glob|follow)(=|$)/.test(a) || shortHas(a, "L"))) return false;
  if (/^[ef]?grep$/.test(prog) && opts.some((a) => a === "--dereference-recursive" || shortHas(a, "R"))) return false;
  // GNU diff -r follows symlinks below its operands
  if (prog === "diff" && opts.some((a) => a === "--recursive" || shortHas(a, "r"))) return false;
  if (prog === "tree" && opts.some((a) => a === "-o" || a === "-l")) return false;
  if (prog === "file" && opts.some((a) => shortHas(a, "C") || a === "--compile")) return false;
  const skip = new Set<number>();
  if (prog === "rg" || /^[ef]?grep$/.test(prog)) {
    // the first operand is the pattern unless -e/-f (or --regexp/--file) gave one
    const given = opts.some((a) => /^--(regexp|file)(=|$)/.test(a) || (/^-[A-Za-z]+$/.test(a) && /[ef]/.test(a.slice(1))));
    let o = true;
    for (let k = 0; !given && k < args.length; k++) {
      if (o && args[k] === "--") o = false;
      else if (!o || !args[k].startsWith("-") || args[k] === "-") {
        skip.add(k);
        break;
      }
    }
  }
  return argsOk(c, cwd, args, skip);
}

/** Positional file operands of a sed call (the script operand dropped), or null on an option it does not know. */
function sedFiles(args: string[]): { files: string[]; scripts: string[]; inPlace: boolean } | null {
  const files: string[] = [];
  const scripts: string[] = [];
  let inPlace = false;
  let opts = true;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!opts || a === "-" || !a.startsWith("-")) files.push(a);
    else if (a === "--") opts = false;
    else if (a === "-i") {
      inPlace = true;
      if (args[k + 1] === "") k++; // BSD `sed -i '' ...`
    } else if (/^-i[A-Za-z0-9._~-]+$/.test(a) || /^--in-place(=[A-Za-z0-9._~-]*)?$/.test(a)) inPlace = true;
    else if (a === "-e" || a === "--expression") {
      if (++k >= args.length) return null;
      scripts.push(args[k]);
    } else if (a.startsWith("--expression=")) scripts.push(a.slice("--expression=".length));
    else if (/^--(quiet|silent|regexp-extended|separate|unbuffered|null-data)$/.test(a)) continue;
    else if (/^-[nErsuz]+e$/.test(a)) {
      if (++k >= args.length) return null;
      scripts.push(args[k]);
    } else if (/^-[nErsuz]+$/.test(a)) continue;
    else return null;
  }
  if (!scripts.length) {
    if (!files.length) return null;
    scripts.push(files.shift()!);
  }
  return { files, scripts, inPlace };
}

/** One plain substitution: `[addr]s<d>re<d>repl<d>[gIiMmp0-9]`, nothing after it (no e or w flag). */
export function plainSubst(script: string): boolean {
  const s = script;
  let i = /^(?:\d+(?:,(?:\d+|\$))?|\$)?/.exec(s)![0].length;
  if (s[i] !== "s") return false;
  const d = s[i + 1];
  if (!d || /[\w\s\\]/.test(d)) return false;
  i += 2;
  for (let part = 0; part < 2; part++) {
    while (i < s.length && s[i] !== d) i += s[i] === "\\" ? 2 : 1;
    if (i >= s.length) return false;
    i++;
  }
  return /^[gIiMmp0-9]*$/.test(s.slice(i));
}

const quoteWord = (w: string): string | null => (!w.includes("'") ? `'${w}'` : null);

function sedEffect(c: EffectCtx, cwd: string | null, words: string[]): { cls: EffectClass; label?: string } {
  const parsed = sedFiles(words.slice(1));
  if (!parsed) return { cls: "unknown" };
  if (parsed.inPlace) {
    if (!parsed.files.length || !parsed.scripts.every(plainSubst)) return { cls: "unknown" };
    return parsed.files.every((f) => f !== "-" && contained(c, cwd, f, true)) ? { cls: "write-in", label: "effect-write-in" } : { cls: "write-out" };
  }
  const quoted = words.map(quoteWord);
  if (quoted.some((q) => q === null) || !isReadOnlySed(quoted.join(" "))) return { cls: "unknown" };
  return parsed.files.every((f) => f === "-" || contained(c, cwd, f, false)) ? { cls: "read", label: "sed-read" } : { cls: "unknown" };
}

const WRITE_FLAGS: Record<string, RegExp> = { mkdir: /^-[pv]+$/, touch: /^-[acm]+$/, cp: /^-[rRapfnv]+$/, mv: /^-[fnv]+$/, rm: /^-[rRfdv]+$/, tee: /^-[aip]+$/ };

function writeVerb(c: EffectCtx, cwd: string | null, prog: string, args: string[]): EffectClass {
  const ops: string[] = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === "--") opts = false;
    else if (opts && a.startsWith("-") && a !== "-") {
      if (!WRITE_FLAGS[prog].test(a)) return "unknown";
    } else ops.push(a);
  }
  if (prog !== "tee" && ops.length < (prog === "cp" || prog === "mv" ? 2 : 1)) return "unknown";
  if (ops.includes("-")) return "unknown";
  // a recursive copy keeps the symlinks of its source tree: only from the worktree (shared /tmp can be planted)
  if (prog === "cp" && args.some((a) => /^-[A-Za-z]*[rRa]/.test(a)) && !ops.slice(0, -1).every((o) => c.root !== null && contained(c, cwd, o, false, [c.root]))) return "write-out";
  const reads = prog === "cp" ? ops.slice(0, -1) : [];
  const writes = prog === "cp" ? ops.slice(-1) : ops;
  // rm and mv never reach into the shared /tmp (as tmp-scratch: `rm -rf /tmp/...` stays reviewed)
  const where = prog === "rm" || prog === "mv" ? [...(c.root ? [c.root] : []), ...(c.scratch ?? [])] : undefined;
  return reads.every((o) => contained(c, cwd, o, false)) && writes.every((o) => contained(c, cwd, o, true, where)) ? "write-in" : "write-out";
}

const GIT_READ = new Set(["status", "log", "diff", "show"]);
const GIT_DRY = new Set(["add", "clean", "mv", "rm"]);

function gitEffect(c: EffectCtx, cwd: string | null, args: string[]): { cls: EffectClass; known: boolean } {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) return { cls: "unknown", known: true }; // git global options (-c, -C, ...)
  const rest = args.slice(1);
  if (GIT_READ.has(sub)) {
    if (rest.some((a) => a === "-c" || a === "-o" || a.startsWith("--output") || a === "--ext-diff" || a.startsWith("--textconv"))) return { cls: "unknown", known: true };
    return { cls: argsOk(c, cwd, rest) ? "read" : "unknown", known: true };
  }
  if (GIT_DRY.has(sub) && gitDryRun(sub, rest)) return { cls: argsOk(c, cwd, rest) ? "read" : "unknown", known: true };
  if (sub === "commit") return { cls: "unknown", known: true }; // `commit -n` is --no-verify, not a dry run
  return { cls: "unknown", known: false };
}

/** Long options of git add/clean/mv/rm that take a value (also by a unique prefix): `-n` after them may be that value. */
const GIT_VALUE_OPTS = ["exclude", "chmod", "pathspec-from-file"];

/** `-n`/`--dry-run` before `--`, with no value-taking option that could swallow it (`git clean -fdx -e -n`). */
function gitDryRun(sub: string, rest: string[]): boolean {
  const dd = rest.indexOf("--");
  const opts = (dd < 0 ? rest : rest.slice(0, dd)).filter((a) => a.startsWith("-"));
  for (const a of opts) {
    const name = a.startsWith("--") ? a.slice(2).split("=")[0] : null;
    if (name && GIT_VALUE_OPTS.some((v) => v.startsWith(name))) return false;
    if (!name && sub === "clean" && /^-[A-Za-z]*e/.test(a)) return false; // -e<pattern> / -e <pattern>
  }
  return opts.some((a) => a === "--dry-run" || /^-[A-Za-z]*n[A-Za-z]*$/.test(a));
}

/** `git restore [--worktree|-W] [--] <paths>` / `git checkout -- <paths>`, every path a test file inside the worktree. */
export function testRestore(c: EffectCtx, cwd: string | null, words: string[]): boolean {
  if (words[0] !== "git" || !c.root) return false;
  let paths: string[];
  if (words[1] === "restore") {
    let k = 2;
    while (words[k] === "--worktree" || words[k] === "-W") k++;
    if (words[k] === "--") k++;
    paths = words.slice(k);
  } else if (words[1] === "checkout" && words[2] === "--") paths = words.slice(3);
  else return false;
  const x = px(c);
  return (
    paths.length > 0 &&
    paths.every((p) => {
      if (!p || p.startsWith("-") || p.startsWith(":") || /[*?[\]]/.test(p) || x.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
      const abs = resolveWord(c, cwd, p);
      if (!abs || !contained(c, cwd, p, true, [c.root!])) return false;
      return isTestPath(x.relative(x.resolve(c.root!), abs));
    })
  );
}

// ------------------------------------------------------------------ manifest (build-test)

interface Manifest {
  pkg: boolean;
  scripts: Set<string>;
  cargo: boolean;
  gomod: boolean;
  pytest: boolean;
  makefile: boolean;
  makeTests: Set<string>;
}

const manifests = new WeakMap<EffectCtx, Manifest>();

function manifestOf(c: EffectCtx): Manifest {
  const hit = manifests.get(c);
  if (hit) return hit;
  const read = (f: string): string | null => {
    if (c.readFile) return c.readFile(f);
    try {
      return fs.readFileSync(px(c).join(c.root!, f), "utf8");
    } catch {
      return null;
    }
  };
  const pkgText = read("package.json");
  const scripts = new Set<string>();
  try {
    const sc = pkgText ? (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts : undefined;
    if (sc && typeof sc === "object") for (const k of ["test", "build", "lint"]) if (typeof sc[k] === "string" && (sc[k] as string).trim()) scripts.add(k);
  } catch {
    // not JSON: no scripts
  }
  const make = read("Makefile") ?? read("makefile") ?? read("GNUmakefile");
  const makeTests = new Set<string>();
  for (const m of (make ?? "").matchAll(/^(test[A-Za-z0-9_.-]*)\s*:(?!=)/gm)) makeTests.add(m[1]);
  const m: Manifest = {
    pkg: pkgText !== null,
    scripts,
    cargo: read("Cargo.toml") !== null,
    gomod: read("go.mod") !== null,
    pytest: read("pytest.ini") !== null || /^\[pytest\]/m.test(read("tox.ini") ?? "") || /^\[tool:pytest\]/m.test(read("setup.cfg") ?? "") || /^\[tool\.pytest/m.test(read("pyproject.toml") ?? ""),
    makefile: make !== null,
    makeTests,
  };
  manifests.set(c, m);
  return m;
}

const BUILD_TOOLS = new Set(["npm", "cargo", "go", "make", "pytest", "python", "python3"]);
// publish and pack run the prepack/prepare scripts even with --dry-run: not a read
const NPM_DRY = new Set(["install", "i", "ci", "uninstall", "update", "dedupe", "prune"]);
/** Build options that write where they choose or name a program to run: refused outright (model review). */
const BUILD_BAD = /^--?(o|exec|toolexec|basetemp|junit-?xml|result-?log|report-log|target-dir|out-dir|artifact-dir|manifest-path|prefix|script-shell|directory|C|f|file|makefile|config|userconfig|globalconfig|node-options|init-module|cache|cache-dir|modfile|overlay|pkgdir|outputdir|(cover|cpu|mem|block|mutex)profile|trace|override-ini|rootdir|log-file|html|cov-report)(=|$)/;

/** "build-test" / "read" (a dry run) for a manifest command run from the worktree root, "unknown" for a refused option, else null. */
function buildTest(c: EffectCtx, cwd: string | null, prog: string, args: string[]): EffectClass | null {
  const pytest = prog === "pytest" || ((prog === "python" || prog === "python3") && args[0] === "-m" && args[1] === "pytest");
  const checked = prog === "npm" || prog === "cargo" || prog === "go" || pytest;
  if (checked && args.some((a) => BUILD_BAD.test(a) || PROGRAM_OPT.test(a) || (pytest && /^-[op]/.test(a)))) return "unknown";
  if (!c.root || cwd === null || !within(c, c.root, cwd, false) || !within(c, cwd, c.root, false)) return null;
  if (!argsOk(c, cwd, args)) return null;
  const m = manifestOf(c);
  const [sub, ...rest] = args;
  const positional = rest.filter((a) => !a.startsWith("-"));
  if (prog === "npm") {
    if (args.includes("--dry-run") && NPM_DRY.has(sub)) return "read";
    if (!m.pkg) return null;
    if (sub === "test") return m.scripts.has("test") ? "build-test" : null;
    if (sub === "run" || sub === "run-script") return m.scripts.has(rest[0]) ? "build-test" : null;
    if (sub === "ci") return "build-test";
    if (sub === "install" || sub === "i") return !positional.length && !rest.some((a) => /^(-g|--global|--location)/.test(a)) ? "build-test" : null;
    return null;
  }
  if (prog === "cargo") {
    if (sub === "publish" && args.includes("--dry-run")) return "read";
    if (!m.cargo) return null;
    if (sub === "test" || sub === "build" || sub === "clippy") return "build-test";
    return sub === "fmt" && rest.includes("--check") ? "build-test" : null;
  }
  if (prog === "go") return m.gomod && (sub === "test" || sub === "build" || sub === "vet") ? "build-test" : null;
  if (prog === "make") {
    if (!m.makefile) return null;
    if (args.some((a) => a === "-n" || a === "--dry-run" || a === "--just-print" || a === "--recon")) return args.every((a) => !/^(-[Cf]|--directory|--file|--makefile)/.test(a)) ? "read" : null;
    const targets = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
    if (!targets.length || !targets.every((t) => m.makeTests.has(t))) return null;
    return args.every((a) => !a.startsWith("-") || /^(-j\d*|-k|-s|--keep-going|--silent)$/.test(a)) ? "build-test" : null;
  }
  if (prog === "pytest" || ((prog === "python" || prog === "python3") && sub === "-m" && rest[0] === "pytest")) return m.pytest ? "build-test" : null;
  return null;
}

// ------------------------------------------------------------------ redirects, segments, chains

/** A redirect the deterministic allow accepts: an fd dup, /dev/null, output into a scratch dir or /tmp, input from a contained path. */
export function redirectOk(r: Redirect, c: EffectCtx | null, cwd: string | null, scratch: string[], platform: string): boolean {
  if (r.op === "dup") return /^\d+$/.test(r.target);
  if (r.target === "/dev/null") return true;
  if (r.op === "<") return c !== null && contained(c, cwd, r.target, false);
  if (scratch.length && insideScratch(r.target, scratch, platform)) return true;
  return platform !== "win32" && tmpDest(r.target);
}

/** The effect of one segment of a split chain (shellchain.ts), with `cwd` the cwd it runs in. */
export function segmentEffect(c: EffectCtx, cwd: string | null, seg: Segment): SegmentEffect {
  const no = (cls: EffectClass, known: boolean, unit = seg.text): SegmentEffect => ({ cls, known, cwd, unit });
  if (refusedProgram(seg.words)) return no("unknown", true);
  for (const r of seg.redirects) if (!redirectOk(r, c, cwd, c.scratch ?? [], plat(c))) return no(r.op === "<" ? "unknown" : "write-out", true);
  let words = seg.words;
  let unit = seg.text;
  let wrapped = false;
  if (words[0] === "timeout") {
    const inner = unwrapTimeout(seg.text);
    const sub = inner ? splitChain(inner) : null;
    if (!inner || !sub || sub.segments.length !== 1 || sub.segments[0].redirects.length || sub.segments[0].words[0] === "timeout" || refusedProgram(sub.segments[0].words)) return no("unknown", true);
    words = sub.segments[0].words;
    unit = inner;
    wrapped = true;
  }
  const out = (cls: EffectClass, known: boolean, label?: string, next: string | null = cwd): SegmentEffect => ({ cls, known, cwd: next, unit, wrapped, ...(label && SAFE_CLASSES.includes(cls) ? { label } : {}) });
  const [prog, ...args] = words;
  if (prog === "cd") {
    // `cd`, `cd -P`, `cd --`, `cd -`, `cd ~` go to $HOME or $OLDPWD: refused, the later cwd is unknown
    if (wrapped || args.length !== 1 || args[0].startsWith("-") || args[0].startsWith("~")) return out("unknown", true, undefined, null);
    const abs = resolveWord(c, cwd, args[0]);
    if (abs && contained(c, cwd, args[0], false)) return out("read", true, "cd", abs);
    return out("unknown", false, undefined, abs);
  }
  // a program run from a cwd outside the allowed places reads or writes there (`cd /etc && ls`)
  const known = READ.has(prog) || prog === "sed" || prog in WRITE_FLAGS || prog === "git";
  if (known && !contained(c, cwd, ".", false)) return out("unknown", true);
  if (READ.has(prog)) return readVerb(c, cwd, prog, args) ? out("read", true, "effect-read") : out("unknown", true);
  if (prog === "sed") {
    const e = sedEffect(c, cwd, words);
    return out(e.cls, true, e.label);
  }
  if (prog in WRITE_FLAGS) {
    const cls = writeVerb(c, cwd, prog, args);
    return out(cls, true, "effect-write-in");
  }
  if (prog === "git") {
    if (testRestore(c, cwd, words)) return out("write-in", true, "test-restore");
    const g = gitEffect(c, cwd, args);
    return out(g.cls, g.known, "effect-read");
  }
  if (BUILD_TOOLS.has(prog)) {
    const b = buildTest(c, cwd, prog, args);
    return b ? out(b, true, b === "read" ? "effect-read" : b === "build-test" ? "effect-build-test" : undefined) : out("unknown", false);
  }
  return out("unknown", false);
}

/**
 * The destinations earlier segments of a chain wrote (cp/mv/ln/install/rsync/tee targets, output
 * redirects): a later segment's path at or below one may run through a symlink the copy planted
 * (`cp -R /tmp/pkg vendor && cat vendor/link`), which the review-time realpath check cannot see.
 */
export class ChainWrites {
  private readonly dests: string[] = [];
  private readonly c: EffectCtx;
  constructor(c: EffectCtx) {
    this.c = c;
  }

  /** False when `seg`, run in `cwd`, names a path at or below an earlier destination; else records its own. */
  pass(cwd: string | null, seg: Segment): boolean {
    const x = px(this.c);
    const abs = (w: string): string | null => (cwd === null && !x.isAbsolute(w) ? null : x.resolve(cwd ?? "", w));
    const value = (w: string): string => (!w.startsWith("-") ? w : w.includes("=") ? w.slice(w.indexOf("=") + 1) : "");
    const named = [...seg.words.slice(1).map(value), ...seg.redirects.filter((r) => r.op !== "dup").map((r) => r.target)].filter(Boolean);
    for (const w of named) {
      const a = abs(w);
      if (a && this.dests.some((d) => within(this.c, d, a, false))) return false;
    }
    let words = seg.words;
    if (words[0] === "timeout") {
      const inner = unwrapTimeout(seg.text);
      words = (inner ? splitChain(inner)?.segments[0]?.words : null) ?? [];
    }
    const ops = words.slice(1).filter((w) => !w.startsWith("-"));
    const prog = (words[0] ?? "").replace(/^.*\//, "");
    const out = prog === "tee" ? ops : ["cp", "mv", "ln", "install", "rsync"].includes(prog) ? ops.slice(-1) : [];
    for (const w of [...out, ...seg.redirects.filter((r) => r.op !== "dup" && r.op !== "<").map((r) => r.target)]) {
      const a = abs(w);
      if (a && w !== "/dev/null") this.dests.push(a);
    }
    return true;
  }
}

/** `command` with $FOREMAN_SCRATCH resolved once per scratch dir (the command itself when there is none). */
export function scratchExpansions(command: string, scratch: string[]): string[] {
  const out = scratch.map((d) => expandScratchVar(command, d)).filter((t): t is string => t !== null);
  return out.length ? out : [command];
}

/** The effect class of a whole command (see the header): its worst segment, the best reading over the scratch dirs. */
export function classify(command: string, c: EffectCtx): EffectClass {
  let best: EffectClass = "unknown";
  for (const text of scratchExpansions(command, c.scratch ?? [])) {
    const chain = splitChain(text);
    if (!chain) continue;
    let worst: EffectClass = "read";
    let cwd: string | null = c.cwd;
    const writes = new ChainWrites(c);
    for (const seg of chain.segments) {
      const e = segmentEffect(c, cwd, seg);
      const cls = writes.pass(cwd, seg) ? e.cls : "unknown";
      if (RANK[cls] > RANK[worst]) worst = cls;
      cwd = e.cwd;
    }
    if (RANK[worst] < RANK[best]) best = worst;
  }
  return best;
}
