// Gate floors (round 41, plan 2.2): deny with a reason that names the alternative; no model, no dialog, no override.
// Pure functions over the shellast.ts segments and the raw text. The same rules for every session kind.
// The git-config key list is one file shared with the tests (git-floor-keys.json, read at module load).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_DEPTH, beforeParseError, carryFacts, blankComments, blankHeredocBodies, parseShell, shellReadsStdin, type ShellSegment } from "./shellast.ts";
import { comparableFs, lexUnder, memoLookup, normPath, sameOrUnder, shortNameSpellings, tildeWord, type Resolver } from "./pathnorm.ts";
import { globMatch, globSegMatch, wildcardRegExp } from "./glob.ts";
import { FIND_BAD, GIT_READ, READ_CLASS, READ_PROGS, RUNNERS, gitReadWrites } from "./effects.ts";
import { nonPathArgs } from "./patternargs.ts";
import { SSH_ARG } from "./protected.ts";
import { protectedMatch } from "./protectedmatch.ts";
import { psUnitTexts } from "./psunits.ts";
import { redactCommand } from "./trace.ts";
import { workspaceOf } from "./python.ts";

interface FloorKeys {
  keyPatterns: string[];
  sectionNames: string[];
  remoteSubcommands: string[];
  protectedBranches: string[];
}

export const GIT_FLOOR_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-floor-keys.json");
const KEYS = JSON.parse(fs.readFileSync(GIT_FLOOR_KEYS_FILE, "utf8")) as FloorKeys;
const KEY_RES = KEYS.keyPatterns.map((p) => new RegExp(p));
const REMOTE_SUBS = new Set(KEYS.remoteSubcommands);

/** The refusal for a push by a child that is not a builder from a single launch. */
const PUSH_CHILD_TEXT = "Only a builder from a single launch pushes; other children never push; the foreman pushes. Commit your work and report the branch.";

export interface FloorEnv {
  platform?: string;
  /** The session cwd (the start directory of the line). */
  cwd: string;
  home?: string;
  /** safety.git.protectedBranches; `main` and `master` are always protected. */
  protectedBranches?: string[];
  /** Roots a delete or a recursive overwrite may reach: the worktree, scratch dirs, the OS temp dir, owned write roots. */
  writeRoots?: string[];
  /** The session's own scratch dirs (its FOREMAN_SCRATCH root); counted as inside for the delete and overwrite floors. Default: none (the process environment is never read for it). */
  scratch?: string[];
  /** A child's `$FOREMAN_OUT` (its kept output dir; also one of `scratch`): the parser reads the variable as that constant, like `$FOREMAN_SCRATCH`. */
  out?: string;
  /** The session's worktree-side scratch base (`<root>/.foreman/scratch`); counted as own temp like the temp base. */
  scratchBase?: string;
  /** The Pi agent dir (its auth.json is a secret path; its pi-foreman policy and state files are floored writes). */
  agentDir?: string;
  /** The dir of the session's own Pi session file: its `*.jsonl` files are floored writes (the adapter writes them through pi.appendEntry). */
  sessionDir?: string;
  /** The bundled package root. */
  pkgRoot?: string;
  currentBranch?: (cwd: string) => string | null;
  remoteHead?: (cwd: string) => string | null;
  /** A subagent child session: it never pushes unless it is a builder (`builder`); the foreman pushes. */
  child?: boolean;
  /** A read-only child in a round (reviewer, explorer): read only by `scratchGitConfigRead`, which lets it read the `.git/config` of a copy in its own scratch dir. */
  readOnlyChild?: boolean;
  /** The effective directory of the segment being judged (null: unknown); read only by `scratchGitConfigRead`, set on a copy at the segment call site. `cwd` stays the session cwd. */
  segCwd?: string | null;
  /** The child is a builder from a single launch (launch binding role `builder`); fail-closed: unset means a child that never pushes. */
  builder?: boolean;
  /** realpath of an existing path for the long-name forms (tests stub it; default: the native realpath). */
  resolver?: Resolver;
}

export interface FloorHit {
  /** The floor rule name, `floor-<name>`. */
  rule: string;
  reason: string;
  /**
   * `deny`: the call is refused, nothing lifts it. `ask` (r79 item 4): a text match on a line the parser could not state exactly; the owner is
   * asked, no model first. `judge`: a judge-first kind (rule `danger-<name>`): the judge reads the call first and a clear runs it, anything else asks the
   * owner (the foreman) or the parent (a child). A deny always wins over an ask, and an ask over a judge-first hit, on the same line.
   */
  kind: "deny" | "ask" | "judge";
  /** The text that matched (raw and opaque-text floors: the regex match; segment floors: program and deciding argument; path floors: the path as written), redacted like the gate log (secrets `[redacted]`, home directory `~`) and cut by `cutFragment`. The gate appends it to the denial; `reason` itself does not carry it. */
  fragment?: string;
  /** Rule names (`danger-<name>`) of the other judge-first hits of the same line that lost to this one (only on a `judge` hit; the chosen hit and every verdict stay as they were). */
  also?: string[];
}

/** A fragment of the matched text for a denial: redacted (as the gate log), control characters removed, cut to 80 characters. */
export const cutFragment = (s: string): string => redactCommand(s).replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}\p{Cf}]/gu, "").slice(0, 80); // redact the whole text first: a cut inside a secret would defeat the patterns that need a closing quote or `@`

const hit = (name: string, reason: string, fragment?: string): FloorHit => ({ rule: `floor-${name}`, kind: "deny", reason: `pi-foreman: denied by the permission floor (${name}). ${reason} No review, policy entry or dialog lifts this floor.`, ...(fragment ? { fragment: cutFragment(fragment) } : {}) });
const askHit = (name: string, reason: string, fragment?: string): FloorHit => ({ rule: `floor-${name}`, kind: "ask", reason: `${reason} (the line is not plain enough for the parser, so the owner decides)`, ...(fragment ? { fragment: cutFragment(fragment) } : {}) });

/** A judge-first hit: the call is not refused, the judge looks at it before it runs (rule `danger-<name>`, the label the owner dialog and the log show). */
const judgeHit = (name: string, reason: string, fragment?: string): FloorHit => ({ rule: `danger-${name}`, kind: "judge", reason, ...(fragment ? { fragment: cutFragment(fragment) } : {}) });

/** The stronger of two non-deny hits: an ask (the owner decides at once) over a judge-first hit. */
export const strongerHit = (a: FloorHit | null, b: FloorHit | null): FloorHit | null => absorb(a?.kind === "ask" ? a : b?.kind === "ask" ? b : a ?? b, a, b);

/** The judge-first rule names a hit stands for: its own and the ones it absorbed. */
const judgeNames = (h: FloorHit | null): string[] => (h ? [...(h.kind === "judge" ? [h.rule] : []), ...(h.also ?? [])] : []);

/** `kept`, a judge-first hit, with the judge-first rules of the `others` it won over in `also` (the same object when there is none). */
function absorb(kept: FloorHit | null, ...others: (FloorHit | null)[]): FloorHit | null {
  if (kept?.kind !== "judge") return kept;
  const also = [...new Set([...judgeNames(kept), ...others.flatMap(judgeNames)])].filter((n) => n !== kept.rule);
  return also.length === 0 && !kept.also ? kept : { ...kept, also };
}

const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).toLowerCase().replace(/\.exe$/, "");
const isWord = (w: string): boolean => !/[$`*?[\]{}]/.test(w) && !tildeWord(w);

// ------------------------------------------------------------------ git

/** True when the (lower-cased) config key is a floored key. */
export function floorKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return KEY_RES.some((re) => re.test(k));
}

const floorSection = (name: string): boolean => {
  const n = name.trim().toLowerCase();
  return floorKey(n) || floorKey(`${n}.x`) || KEYS.sectionNames.some((s) => n === s || n.startsWith(`${s}.`));
};

const GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source", "--exec-path", "--config-env"]);

/** How many words the global git option at `a[i]` takes: 2 when it is a value-taking option without a glued value, else 1. The one reader of git's global options. */
export function gitGlobalWidth(a: string[], i: number): number {
  return GLOBAL_VALUE.has(a[i]) ? 2 : 1;
}

interface GitCall {
  sub: string;
  rest: string[];
  /** `-c key=value` and `--config-env key=ENV` keys. */
  overrides: string[];
  cwd: string | null;
  /** The `--git-dir` value, resolved against the cwd. */
  gitDir: string | null;
}

function gitCall(seg: ShellSegment, env: FloorEnv): GitCall | null {
  if (base(seg.program) !== "git") return null;
  const a = seg.argv;
  const overrides: string[] = [];
  let cwd = seg.cwd ?? env.cwd;
  let gitDir: string | null = null;
  let i = 0;
  while (i < a.length && a[i].startsWith("-") && a[i] !== "--") {
    const w = a[i];
    if (w === "--git-dir" || w.startsWith("--git-dir=")) {
      const v = w === "--git-dir" ? a[i + 1] : w.slice("--git-dir=".length);
      if (v !== undefined) gitDir = path.resolve(cwd, v);
    } else if (w === "-c" || w === "--config-env") overrides.push(a[i + 1] ?? "");
    else if (/^-c.+/.test(w)) overrides.push(w.slice(2));
    else if (w === "-C") {
      if (a[i + 1] !== undefined) cwd = path.resolve(cwd, a[i + 1]);
    } else if (w.startsWith("--config-env=")) overrides.push(w.slice("--config-env=".length));
    i += gitGlobalWidth(a, i);
  }
  return { sub: (a[i] ?? "").toLowerCase(), rest: a.slice(i + 1), overrides, cwd, gitDir };
}

const keyOfOverride = (o: string): string => o.split("=", 1)[0];

const CONFIG_VALUE_OPTS = new Set(["-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--url", "--value"]);
const CONFIG_READ_OPTS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"]);
const CONFIG_WRITE_OPTS = new Set(["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"]);

function configFloor(call: GitCall): FloorHit | null {
  const words: string[] = [];
  const opts = new Set<string>();
  let ended = false;
  for (let i = 0; i < call.rest.length; i++) {
    const w = call.rest[i];
    if (!ended && w === "--") ended = true;
    else if (!ended && w.startsWith("--") && w.includes("=")) opts.add(w.slice(0, w.indexOf("=")));
    else if (!ended && w.startsWith("-") && w.length > 1) {
      opts.add(w);
      if (CONFIG_VALUE_OPTS.has(w)) i++;
    } else words.push(w);
  }
  const has = (set: Set<string>): boolean => [...opts].some((o) => set.has(o));
  const first = (words[0] ?? "").toLowerCase();
  if (opts.has("-e") || opts.has("--edit") || first === "edit") return judgeHit("git-config", "`git config --edit` can set any key, including core.hooksPath, remote urls and credential helpers.");
  if (has(CONFIG_READ_OPTS) || first === "get" || first === "list") return null;
  const sectionOp = opts.has("--rename-section") || opts.has("--remove-section") || first === "rename-section" || first === "remove-section";
  if (sectionOp) {
    const name = first === "rename-section" || first === "remove-section" ? words[1] : words[0];
    if (name === undefined || !isWord(name) || floorSection(name)) return judgeHit("git-config", `Renaming or removing the config section '${name ?? "?"}' changes hooks, remotes, urls or credentials.`);
    return null;
  }
  const setForm = first === "set" || first === "unset";
  const key = setForm ? words[1] : words[0];
  const writes = setForm || has(CONFIG_WRITE_OPTS) || words.length >= 2;
  if (!writes) return null; // `git config <key>` reads
  if (key === undefined) return null;
  if (!isWord(key)) return judgeHit("git-config", `The config key '${key}' is computed, so it cannot be read.`);
  if (floorKey(key)) return judgeHit("git-config", `Writing the git config key '${key}' changes where code is fetched or pushed, which program git runs or which credentials it uses.`);
  return null;
}

/** Whether `git remote <sub>` changes a remote. */
function remoteFloor(call: GitCall): FloorHit | null {
  const sub = call.rest.find((w) => !w.startsWith("-"))?.toLowerCase() ?? "";
  if (!REMOTE_SUBS.has(sub)) return null;
  return judgeHit("git-config", `\`git remote ${sub}\` changes where fetches and pushes go.`);
}

const PUSH_VALUE = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o", "--signed"]);
const PUSH_FORCE = /^--(force|force-with-lease|force-if-includes|mirror|delete|prune)(=.*)?$/;

function protectedSet(env: FloorEnv): Set<string> {
  return new Set([...KEYS.protectedBranches, ...(env.protectedBranches ?? [])].map((b) => b.trim()).filter(Boolean));
}

const stripHeads = (r: string): string => r.replace(/^(?:refs\/)?heads\//, "");

/** The two push floors (plan Addendum 2): (a) force, delete, mirror, a leading `+` or an empty source (`:dst`) or several `:` in a refspec (a `src:dst` refspec goes through (b) on dst); (b) any push whose target is a default or protected branch. */
function pushFloor(call: GitCall, env: FloorEnv): FloorHit | null {
  const positional: string[] = [];
  let force: string | null = null;
  let all = false;
  let ended = false;
  for (let i = 0; i < call.rest.length; i++) {
    const w = call.rest[i];
    if (!ended && w === "--") ended = true;
    else if (!ended && w.startsWith("--")) {
      const name = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
      if (PUSH_FORCE.test(w)) force ??= name;
      else if (name === "--all" || name === "--branches") all = true;
      else if (PUSH_VALUE.has(name) && !w.includes("=")) i++;
    } else if (!ended && w.startsWith("-") && w.length > 1) {
      const letters = w.slice(1);
      if (/[fd]/.test(letters)) force ??= w;
      if (letters.endsWith("o")) i++;
    } else positional.push(w);
  }
  const alt = "Push only your own branch explicitly: `git push -u origin <your-branch>`. Ask the user for force pushes, deletions, mirror pushes and pushes to a default branch.";
  if (force) return hit("git-push-force", `\`git push ${force}\` rewrites or deletes remote refs. ${alt}`);
  const refspecs = positional.slice(1).filter((r) => r !== "tag");
  // a `src:dst` whose destination is a variable cannot be compared with the protected branches: refused as before the refspec relaxation
  const odd = refspecs.find((r) => r.startsWith("+") || r.startsWith(":") || r.endsWith(":") || r.split(":").length > 2 || (r.includes(":") && /[$`]/.test(r.slice(r.indexOf(":") + 1))));
  if (odd !== undefined) return hit("git-push-force", `The refspec '${odd}' can overwrite or delete any remote ref. ${alt}`);
  const prot = [...protectedSet(env)];
  const cwd = call.cwd ?? env.cwd;
  const head = env.remoteHead?.(cwd);
  if (head) prot.push(head);
  const targets = refspecs.map((r) => (r === "HEAD" ? env.currentBranch?.(cwd) ?? "HEAD" : stripHeads(r.includes(":") ? r.slice(r.indexOf(":") + 1) : r)));
  if (!refspecs.length && !all) {
    const cur = env.currentBranch?.(cwd);
    if (cur) targets.push(cur);
  }
  if (all) return hit("git-push-protected", `\`git push --all\` includes the default and protected branches. ${alt}`);
  const bad = targets.find((t) => protectedMatch(prot, t, { ignoreCase: true }) !== undefined);
  if (bad !== undefined) return hit("git-push-protected", `'${bad}' is a default or protected branch. ${alt}`);
  return null;
}

/** The repo's work tree root above `cwd` and, for a linked worktree, the main checkout (lexical fallback: `cwd` itself). */
function repoRoots(cwd: string): string[] {
  let cur = cwd;
  for (let n = 0; n < 64; n++) {
    const dotGit = path.join(cur, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return [cur];
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      // a relative link resolves against the file that holds it (git's worktree.useRelativePaths, submodules)
      const link = m ? path.resolve(cur, m[1].trim()) : "";
      const main = m ? /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(link)?.[1] : undefined;
      return main ? [cur, main] : [cur];
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return [cwd];
}

/** `git -c core.attributesFile=<path> <verb>`: only `merge` with the file under the repo's .workflow/ goes on to the review (a merge driver runs arbitrary commands). */
function attributesFloor(call: GitCall, value: string, env: FloorEnv): FloorHit | null {
  const alt = "Keep the attributes file under the repo's .workflow/ and use `git -c core.attributesFile=<repo>/.workflow/<file> merge ...`.";
  if (call.sub !== "merge") return hit("git-attributes-file", `\`-c core.attributesFile\` with \`git ${call.sub || "?"}\` can name a merge or filter driver that runs arbitrary commands; only merge is allowed. ${alt}`);
  const cwd = call.cwd ?? env.cwd;
  const win = (env.platform ?? process.platform) === "win32";
  // win32: root and candidate meet in the one long-name form of pathnorm (drive, 8.3, case, separators)
  const wv = win && isWord(value) ? expandWord(value, env, true) : null;
  const abs = isWord(value) ? resolveWord(value, cwd, env) : null;
  const real = abs ? (realDeep(abs) ?? abs) : null;
  const under = win
    ? wv !== null && repoRoots(cwd).some((r) => sameOrUnder("win32", path.win32.join(r, ".workflow"), wv, cwd, env.resolver))
    : real !== null && repoRoots(cwd).some((r) => insideRoot(real, path.join(realDeep(r) ?? r, ".workflow"), env.platform));
  if (!under) return hit("git-attributes-file", `The attributes file '${value}' is not under the repo's .workflow/ (or cannot be resolved); a merge driver it names runs arbitrary commands. ${alt}`);
  return null;
}

/**
 * The git dir git would use from `start` (a `.git` directory, a gitfile `gitdir:` pointer or a symlink, found walking up like git does) and its common dir
 * (`commondir`, set for a linked worktree), both as real paths; null when no repo is found or anything cannot be read.
 */
function gitDirsOf(start: string, explicit: string | null): { gitDir: string; common: string } | null {
  try {
    let gitDir = explicit;
    for (let cur = start, n = 0; !gitDir && n < 64; n++) {
      const dot = path.join(cur, ".git");
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(dot);
      } catch {
        st = null;
      }
      if (st) {
        const m = st.isFile() ? /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8")) : null;
        gitDir = st.isFile() ? (m ? path.resolve(cur, m[1].trim()) : null) : dot;
        if (!gitDir) return null;
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
    if (!gitDir) return null;
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(path.dirname(gitDir), m[1].trim());
    }
    const real = fs.realpathSync(gitDir);
    let common = real;
    try {
      common = fs.realpathSync(path.resolve(real, fs.readFileSync(path.join(real, "commondir"), "utf8").trim()));
    } catch {
      // no commondir file: a plain repo
    }
    return { gitDir: real, common };
  } catch {
    return null;
  }
}

/**
 * The files a `git config` write would change (item 4): the `--file` operand, else the config of the git dir git resolves from the cwd / `-C` / `--git-dir`
 * (for a linked worktree or a gitfile that is the REAL repo's shared config, wherever the work tree sits). Nothing found: no target, so no exemption.
 */
function configTargets(call: GitCall): string[] {
  const cwd = call.cwd ?? ".";
  const files = call.rest.flatMap((w, i) => {
    const v = w.startsWith("--file=") ? w.slice(7) : w === "-f" || w === "--file" ? call.rest[i + 1] : undefined;
    return v ? [path.resolve(cwd, v)] : [];
  });
  if (files.length) return files;
  const dirs = gitDirsOf(cwd, call.gitDir);
  return dirs ? [path.join(dirs.common, "config"), path.join(dirs.gitDir, "config.worktree")] : [];
}

/** Every path is below the child's scratch root (`env.scratch`) or the scratch base `<OS temp dir>/pi-foreman-scratch` (or the session's `env.scratchBase`), in any spelling; at least one path. */
function inOwnTemp(paths: string[], env: FloorEnv): boolean {
  if (!paths.length) return false;
  const plat = env.platform ?? process.platform;
  const roots = [...(env.scratch ?? []), path.join(os.tmpdir(), "pi-foreman-scratch"), ...(env.scratchBase ? [env.scratchBase] : [])].filter(Boolean);
  const rootForms = roots.flatMap((r) => formsOf(r, env));
  return paths.every((p) => formsOf(p, env).every((f) => rootForms.some((r) => lexUnder(plat, r, f))));
}

/**
 * The spellings of the option `long` among `words`, up to `--`: any prefix of it of at least `min` characters (default `--` and one letter), with or
 * without `=value` (git rejects an ambiguous one, so matching it costs nothing); with `short`, also a single-dash cluster where no value-taking letter of
 * clone (`o`, `b`, `u`, `c`, `j`) comes before that letter. One entry per spelling: the glued value (after `=` or the cluster letter), else, with
 * `consume`, the next word (which is then not read as an option), else undefined.
 */
export function gitOptSpellings(words: string[], long: string, opts: { short?: string; consume?: boolean; min?: number } = {}): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  const end = words.indexOf("--");
  const list = end < 0 ? words : words.slice(0, end);
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    let glued: string | undefined;
    if (w.startsWith("--")) {
      const name = w.split("=", 1)[0];
      if (name.length < (opts.min ?? 3) || !long.startsWith(name)) continue;
      glued = w.includes("=") ? w.slice(w.indexOf("=") + 1) : undefined;
    } else if (opts.short !== undefined && /^-[^-]/.test(w)) {
      const chars = Array.from(w);
      const at = chars.findIndex((ch, n) => n > 0 && "obucj".includes(ch));
      if (at < 0 || chars[at] !== opts.short) continue;
      glued = at + 1 < chars.length ? chars.slice(at + 1).join("") : undefined;
    } else continue;
    out.push(glued ?? (opts.consume ? (list[++i] ?? "") : undefined));
  }
  return out;
}

/** The `-c` and `--config` values among the words after `git clone`. */
const cloneConfigs = (rest: string[]): string[] => gitOptSpellings(rest, "--config", { short: "c", consume: true }) as string[];

/** The git subcommands that print objects, so a `<rev>:<path>` word of theirs reads a file (the words of `commit`, `tag` and the like are messages, never read). */
const OBJECT_PRINTERS = new Set(["show", "cat-file", "diff", "grep", "difftool", "merge-file", "notes", "rev-parse", "ls-files"]);
/** The words of `call` that can be `<rev>:<path>`: all of an object printer's; of `log` and `whatchanged` only the `-L` values (a revision operand prints no blob). */
function revWords(call: GitCall): string[] {
  if (OBJECT_PRINTERS.has(call.sub)) return call.rest;
  if (call.sub !== "log" && call.sub !== "whatchanged") return [];
  const out: string[] = [];
  for (let i = 0; i < call.rest.length; i++) {
    const w = call.rest[i];
    if (w === "--") break;
    if (w === "-L") out.push(call.rest[++i] ?? "");
    else if (w.startsWith("-L")) out.push(w.slice(2));
  }
  return out;
}

/** All git floors of one segment: config writes in every form (`git clone -c` included), remote changes, the push floors. */
function gitFloors(seg: ShellSegment, env: FloorEnv): FloorHit | null {
  const call = gitCall(seg, env);
  if (!call) return null;
  // a judge-first hit waits behind every deny of the same segment (a push floor)
  let soft: FloorHit | null = null;
  const clone = call.sub === "clone" ? cloneConfigs(call.rest) : [];
  for (const [o, cloneForm] of [...call.overrides.map((o): [string, boolean] => [o, false]), ...clone.map((o): [string, boolean] => [o, true])]) {
    const key = keyOfOverride(o);
    const form = cloneForm ? "git clone -c or --config" : "-c or --config-env";
    if (!isWord(key) || floorKey(key)) {
      soft ??= judgeHit("git-config", `Setting '${key || "?"}' with ${form} changes where code is fetched or pushed, which program git runs or which credentials it uses.`);
      continue;
    }
    if (key.trim().toLowerCase() === "core.attributesfile") {
      const h = attributesFloor(call, o.slice(o.indexOf("=") + 1), env);
      if (h) return h;
    }
  }
  if (call.sub === "config") return (!call.rest.some((w) => w === "--global" || w === "--system") && inOwnTemp(configTargets(call), env) ? null : configFloor(call)) ?? soft;
  if (call.sub === "remote") return remoteFloor(call) ?? soft;
  if (call.sub === "push" && env.child && !env.builder) return hit("git-push-child", PUSH_CHILD_TEXT);
  if (call.sub === "push") return pushFloor(call, env) ?? soft;
  // `<rev>:<path>` and `:<path>` print the file out of the object store: the path part is judged as any path
  for (const w of revWords(call)) {
    const i = w.indexOf(":");
    const s = i >= 0 ? secretPath(w.slice(i + 1), { ...env, segCwd: call.cwd }, true) : null;
    if (s) return { ...s, fragment: undefined };
  }
  // `-e <pattern>` reads as "keep this", and a pattern that matches nothing deletes the whole tree: judge-first, as every `git clean`
  return soft ?? (call.sub === "clean" ? gitCleanExclude(call) : null);
}

/** `git clean` with `-e` or `--exclude`: it reads as "keep this", and a pattern that matches nothing deletes the whole tree (judge-first, losing local work). */
function gitCleanExclude(call: GitCall): FloorHit | null {
  if (!call.rest.some((w) => w === "--exclude" || w.startsWith("--exclude=") || /^-(?!-)\S*e/.test(w))) return null;
  return judgeHit("git", "`git clean` with `-e` or `--exclude` deletes everything the pattern does not match, and a pattern that matches nothing deletes the whole tree.");
}

// ------------------------------------------------------------------ other programs

const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const DISK = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "wipefs", "diskpart", "mkswap"]);
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put"]);
const OWNERS = new Set(["chmod", "chown", "chgrp"]);
const DOWNLOAD = new Set(["curl", "wget", "fetch", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "http", "https", "xh", "aria2c"]);
const SHELL_LIKE = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "nodejs", "perl", "ruby", "php", "pwsh", "powershell", "iex", "invoke-expression"]);
const DOWNLOAD_SHELL_REASON = "A download piped into a shell or interpreter runs unreviewed code. Download to your scratch dir, read the file, then run what you checked.";

/** The segment's stdin is its own here-document or here-string: a `<`, `<>` or input dup (`<&3`) of the same command on fd 0 may replace it (`python3 - <<E < f`), so then it is no own text. */
export const ownStdinText = (s: ShellSegment): boolean =>
  !!s.heredoc && !s.redirects.some((r) => (r.op === "<" || r.op === "<>" || (r.op === "dup" && r.input === true)) && (r.fd === null || r.fd === "0"));

/**
 * `seg` is a shell or interpreter that reads its program from stdin and the line has a download that may feed it: the download pipes into it (at any earlier stage of its
 * pipeline, so `curl u | cat | python3 - <<E` counts: zsh MULTIOS hands both the pipe and the heredoc to stdin), or the interpreter has no heredoc or here-string of its own, or the
 * download sits inside a substitution (`$(...)`, backticks, process substitution; the text of a here-string or heredoc body included). Only a plain top-level download beside an
 * interpreter fed by its own heredoc or here-string is left out: its stdin is that text, not the download (`python3 - <<EOF ... EOF` and a later `curl -s u -o f`). One check for
 * the shell line (segmentFloors) and for tool-call field text (fieldLineFloors).
 */
function downloadFeedsShell(seg: ShellSegment, line: readonly ShellSegment[]): boolean {
  if (!SHELL_LIKE.has(base(seg.program)) || seg.opaque !== "stdin_fed") return false;
  return line.some((d) => {
    if (d === seg || !DOWNLOAD.has(base(d.program))) return false;
    if (!ownStdinText(seg)) return true;
    const piped = !!d.pipeline && !!seg.pipeline && d.pipeline.id === seg.pipeline.id && d.pipeline.stage < seg.pipeline.stage;
    return piped || d.wrappers.some((w) => w === "$(" || w === "`");
  });
}

const SYSTEM_DIRS = ["bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "opt", "proc", "root", "sbin", "srv", "sys", "usr", "var", "system", "library", "applications", "users", "home", "volumes", "private"];

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+/g, "/");

/** `p` is `root` or below it (lexical; the slash and case rules are pathnorm.ts's: case-folded on win32 only, r79 item 16). */
export function insideRoot(p: string, root: string, platform: string = process.platform): boolean {
  return lexUnder(platform, root, p);
}

function resolveWord(word: string, cwd: string | null, env: FloorEnv, keepGlob = false): string | null {
  const win = (env.platform ?? process.platform) === "win32";
  const v = expandWord(word, env, win, keepGlob);
  if (v === null) return null;
  if (px_(win).isAbsolute(v)) return px_(win).normalize(v);
  return cwd ? px_(win).resolve(cwd, v) : null;
}

const px_ = (win: boolean): typeof path.posix => (win ? path.win32 : path.posix);

/** `word` with `~` and `$HOME` expanded and a glob or variable tail cut to its literal directory prefix; not yet made absolute. */
function expandWord(word: string, env: FloorEnv, win: boolean = (env.platform ?? process.platform) === "win32", keepGlob = false): string | null {
  const px = win ? path.win32 : path.posix;
  const w = word.replace(/^(["'])(.*)\1$/, "$2");
  const home = env.home ?? "";
  let v = w;
  if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) {
    if (!home) return null;
    v = px.join(home, v.slice(1));
  } else if (v === "$HOME" || v.startsWith("$HOME/") || v === "${HOME}" || v.startsWith("${HOME}/")) {
    if (!home) return null;
    v = px.join(home, v.replace(/^\$\{?HOME\}?/, ""));
  }
  // a glob or variable tail: judge the literal directory prefix
  const cut = v.search(keepGlob ? /[$`{]/ : /[$`*?[{]/);
  if (cut >= 0) {
    const pre = v.slice(0, cut);
    v = pre.endsWith("/") || pre.endsWith("\\") ? pre : px.dirname(pre === "" ? "." : pre);
    if (pre === "") return null;
  }
  return v;
}

function systemRemoval(word: string, env: FloorEnv): boolean {
  const w = slash(word.replace(/^(["'])(.*)\1$/, "$2")).replace(/\/\*$/, "/");
  const home = env.home ? slash(env.home).replace(/\/$/, "") : "";
  if (/^(~|\$HOME|\$\{HOME\})\/?$/.test(w)) return true;
  if (/^(~|\$HOME|\$\{HOME\})\/\.?\*?$/.test(w)) return true;
  if (w === "/" || w === "//") return true;
  // a Windows home (drive letter) compares case-insensitively, whatever the host OS
  const fold = (p: string): string => (/^[a-z]:\//i.test(home) ? p.toLowerCase() : p);
  if (home && (fold(w.replace(/\/$/, "")) === fold(home) || fold(w.replace(/\/$/, "")) === fold(path.posix.dirname(home)))) return true;
  const lower = w.replace(/\/$/, "").toLowerCase();
  if (SYSTEM_DIRS.some((d) => lower === `/${d}`)) return true;
  // another user's home folder (`/Users/bob`, `C:\Users\bob`): the old delete check protected the folders one level below these parents
  return /^[a-z]:\/?$/.test(lower) || /^[a-z]:\/(windows|users|program files( \(x86\))?|programdata)$/.test(lower) || /^[a-z]:\/users\/[^/]+$/.test(lower) || /^\/(users|home|volumes|mnt)\/[^/]+$/.test(lower);
}

function deleteOperands(seg: ShellSegment, prog: string): string[] {
  const a = seg.argv;
  if (REMOVERS.has(prog)) {
    const out: string[] = [];
    let ended = false;
    for (const w of a) {
      if (!ended && w === "--") ended = true;
      else if (ended || !w.startsWith("-") || w === "-") out.push(w);
    }
    return out;
  }
  if (prog === "find" && a.some((w) => w === "-delete")) {
    const roots: string[] = [];
    for (const w of a) {
      if (/^-[HLP]$/.test(w)) continue;
      if (w.startsWith("-") || w === "(" || w === "!") break;
      roots.push(w);
    }
    return roots.length ? roots : ["."];
  }
  return [];
}

/** Destination operands of a recursive overwrite (cp -r, rsync, tar -x -C, unzip -d). */
function overwriteDests(seg: ShellSegment, prog: string): string[] {
  const a = seg.argv;
  const ops = a.filter((w) => !w.startsWith("-") || w === "-");
  if (prog === "cp") return a.some((w) => /^-[A-Za-z]*[rRa]|^--(recursive|archive)$/.test(w)) ? ops.slice(-1) : [];
  if (prog === "rsync") return ops.length >= 2 ? ops.slice(-1) : [];
  if (prog === "tar") {
    const extract = a.some((w) => /^-[A-Za-z]*x|^--extract$|^--get$/.test(w)) || /^[A-Za-z]*x/.test(a[0] ?? "");
    if (!extract) return [];
    const out: string[] = [];
    a.forEach((w, i) => {
      if (w === "-C" || w === "--directory") out.push(a[i + 1] ?? "");
      else if (w.startsWith("--directory=")) out.push(w.slice(12));
    });
    return out;
  }
  if (prog === "unzip") {
    const out: string[] = [];
    a.forEach((w, i) => {
      if (w === "-d") out.push(a[i + 1] ?? "");
      else if (/^-d.+/.test(w)) out.push(w.slice(2));
    });
    return out;
  }
  return [];
}

function outside(word: string, cwd: string | null, env: FloorEnv): boolean {
  const abs = resolveWord(word, cwd, env);
  if (abs === null) return false; // unknown: the walker cannot say, the gate's other steps decide
  // r79 item 4: the session's own scratch root (`<tmp>/pi-foreman-scratch/<session>/<run>`, FOREMAN_SCRATCH) is inside, also under another spelling of
  // the temp dir (macOS /var vs /private/var)
  const own = env.scratch ?? [];
  const roots = [...(env.writeRoots ?? []), ...own];
  if (roots.some((r) => insideRoot(abs, r, env.platform))) return false;
  const mine = formsOf(abs, env);
  return !roots.some((r) => formsOf(r, env).some((rf) => mine.some((f) => lexUnder(env.platform ?? process.platform, rf, f))));
}

/**
 * The word a segment writes to, truncates or changes recursively that holds a variable (judge-first for every role): `dd of=$X`, `chmod -R`/`chown -R` with a variable operand, `truncate -s 0 $X`, and a `>` or `&>` redirect whose whole target is a variable.
 */
function unknownWriteTarget(seg: ShellSegment, prog: string): string | undefined {
  const a = seg.argv;
  const operands = (): string[] => a.filter((w) => !w.startsWith("-") || w === "-");
  // the old check read a `>` target that ends the command, nothing after it (`echo > $F arg` is none; the walker sets `redirectEnd`), quoted or not
  const last = seg.redirects[seg.redirects.length - 1];
  if (last && (seg.redirectEnd ?? true) && (last.op === ">" || last.op === "&>") && /^\$\{?[A-Za-z_]\w*\}?$|^`/.test(last.target.replace(/^(["'])(.*)\1$/, "$2"))) return last.target;
  if (prog === "dd") return a.find((w) => w.startsWith('of=') && /[$`]/.test(w));
  if ((prog === "chmod" || prog === "chown") && a.some((w) => /^-[A-Za-z]*R|^--recursive$/.test(w))) return operands().slice(1).find((w) => /[$`]/.test(w));
  if (prog === "truncate" && a.some((w) => w === "0" || w === "--size=0" || w === "-s0")) return operands().find((w) => /[$`]/.test(w));
  return undefined;
}

/** A remover or `find -delete` whose operand is the root, the home directory or a system directory (`rm-system`) or outside the write area (`delete-outside`). */
function deleteFloor(seg: ShellSegment, prog: string, env: FloorEnv): FloorHit | null {
  if (!(REMOVERS.has(prog) || (prog === "find" && seg.argv.includes("-delete")))) return null;
  const ops = deleteOperands(seg, prog);
  const sys = ops.find((w) => systemRemoval(w, env));
  if (sys !== undefined) return hit("rm-system", `Removing '${sys}' (the file system root, the home directory or a system directory) is never allowed. Remove specific files inside the worktree, scratch or /tmp.`);
  const out = ops.find((w) => outside(w, seg.cwd ?? env.cwd, env));
  if (out !== undefined) return hit("delete-outside", `Deleting '${out}' outside the worktree, your scratch dir and /tmp is not allowed. Delete only inside those, or report the path to the user.`);
  return null;
}

/** A recursive `chmod`/`chown` on the root, the home directory or a system directory. */
function chmodFloor(seg: ShellSegment, prog: string, env: FloorEnv): FloorHit | null {
  if (!(OWNERS.has(prog) && seg.argv.some((w) => /^-[A-Za-z]*R|^--recursive$/.test(w)))) return null;
  const sys = seg.argv.filter((w) => !w.startsWith("-")).find((w) => systemRemoval(w, env));
  if (sys !== undefined) return hit("chmod-system", `A recursive \`${prog}\` on '${sys}' (the file system root, the home directory or a system directory) is never allowed. Change specific files inside the worktree, scratch or /tmp.`);
  return null;
}

/** The disk decisions of the old delete check: a `mkfs*` program, `dd of=<device>`, the `diskutil` erase, zero, secure-erase and partition verbs. */
function pythonDisk(seg: ShellSegment, prog: string): boolean {
  return prog.startsWith("mkfs") || (prog === "dd" && seg.argv.some((w) => /^of=(\/dev\/|\\\\\.\\)/i.test(w))) || (prog === "diskutil" && seg.argv.some((w) => /^(erase|partition|reformat|zero|secure|apfs)/i.test(w)));
}

const unknownWriteHit = (target: string): FloorHit => judgeHit("unknown-write-target", `The target '${cutFragment(target)}' of this write, truncation or recursive permission change is a variable the gate cannot read, so it could be any path.`);

/** The floors of one segment, with the fragment of the denial: the program word and the operand the reason names (else the first arguments). */
export function segmentFloors(seg: ShellSegment, env: FloorEnv, line: ShellSegment[]): FloorHit | null {
  const h = segmentFloorsOf(seg, env, line);
  if (!h || h.fragment) return h;
  const named = /'([^']+)'/.exec(h.reason.slice(h.reason.indexOf(").")))?.[1];
  return { ...h, fragment: cutFragment([seg.program, named ?? seg.argv.join(" ")].filter(Boolean).join(" ")) };
}

/** The floors of one segment: a deny when one applies, else the judge-first hit of its git config, terminal injection or scan, if any. */
function segmentFloorsOf(seg: ShellSegment, env: FloorEnv, line: ShellSegment[]): FloorHit | null {
  const soft: { hit: FloorHit | null } = { hit: null };
  return segmentDenyOf(seg, env, line, soft) ?? soft.hit;
}

function segmentDenyOf(seg: ShellSegment, env: FloorEnv, line: ShellSegment[], soft: { hit: FloorHit | null }): FloorHit | null {
  const prog = base(seg.program);
  const git = gitFloors(seg, env);
  if (git?.kind === "deny") return git;
  soft.hit = git;
  const inj = injectFloor(seg, prog);
  const keep = (h: FloorHit | null): void => {
    soft.hit = soft.hit ? absorb(soft.hit, h) : h;
  };
  keep(inj);
  const pw = protectedWrite(seg, prog, env, line);
  if (pw) return pw;
  if (PRIVILEGE.has(prog)) return hit("privilege", `\`${prog}\` escalates privileges. Run the command as the current user; ask the user when root is needed.`);
  const bd = builtinDeny([prog, ...seg.argv].join(" "), env, false);
  if (bd) return bd;
  if (POWER.has(prog) || (prog === "init" && /^[06]$/.test(seg.argv[0] ?? "")) || (prog === "systemctl" && seg.argv.some((w) => /^(poweroff|reboot|halt|kexec)$/.test(w)))) return hit("shutdown", "Shutting down or rebooting the machine is not allowed. Ask the user.");
  if (prog.startsWith("mkfs") || DISK.has(prog) || (prog === "diskutil" && seg.argv.some((w) => /^(erase|partition|reformat|zero|secure|apfs)/i.test(w))) || (prog === "format" && seg.argv.some((w) => /^[a-z]:$/i.test(w)))) {
    return hit("disk", `\`${prog}\` formats or repartitions a disk. Ask the user.`);
  }
  if (prog === "dd" && seg.argv.some((w) => /^of=(\/dev\/|\\\\\.\\)/i.test(w))) return hit("disk", "`dd` to a device overwrites a disk. Write to a file inside the worktree or /tmp instead.");
  const unreadable = unknownWriteTarget(seg, prog);
  if (unreadable !== undefined) keep(unknownWriteHit(unreadable));
  for (const r of seg.redirects) if (r.op !== "<" && r.op !== "dup" && /^\/dev\/(sd|nvme|hd|vd|xvd|disk|rdisk|mmcblk)/i.test(r.target)) return hit("disk", "Redirecting into a block device overwrites a disk. Write to a file inside the worktree or /tmp instead.");
  const del = deleteFloor(seg, prog, env) ?? chmodFloor(seg, prog, env);
  if (del) return del;
  const dests = overwriteDests(seg, prog);
  const dout = dests.find((w) => w !== "" && outside(w, seg.cwd ?? env.cwd, env));
  if (dout !== undefined) return hit("overwrite-outside", `A recursive copy or extract into '${dout}' overwrites files outside the worktree, your scratch dir and /tmp. Extract into your scratch dir or /tmp first.`);
  if (prog === "rsync" && seg.argv.some((w) => w.startsWith('--delete'))) {
    const d = seg.argv.filter((w) => !w.startsWith("-")).slice(-1)[0];
    if (d !== undefined && outside(d, seg.cwd ?? env.cwd, env)) return hit("delete-outside", `\`rsync --delete\` into '${d}' deletes files outside the worktree, your scratch dir and /tmp.`);
  }
  keep(fsScanFloor(seg, env));
  const pub = publishFloor(prog, seg.argv);
  if (pub) return hit("publish", `${pub} publishes a package or image. Ask the user to publish; build and test locally instead.`);
  if (downloadFeedsShell(seg, line)) return hit("download-shell", DOWNLOAD_SHELL_REASON);
  // quoted text and regexes are data (r79 item 4); a terminal payload is typed text, judged by the inject floor above
  const payload = injection(seg, prog)?.words ?? [];
  const patterns = searchPatterns(seg, prog);
  const words = [...seg.argv, ...seg.redirects.map((r) => r.target)];
  const reads = readOperands(seg, prog);
  for (const [i, w] of words.entries()) {
    if ((dataWord(w) && !FORM_LIST.test(w)) || payload.includes(w) || patterns.has(i)) continue;
    const s = secretPath(w, { ...env, segCwd: seg.cwd ?? null }, i < seg.argv.length ? reads.argv(w) : seg.redirects[i - seg.argv.length].op === "<");
    if (s) return s;
  }
  return null;
}

// ------------------------------------------------------------------ whole-filesystem scan

const SCAN_VALUE_FLAGS: Record<string, Set<string>> = {
  grep: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count"]),
  rg: new Set(["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-E", "-r", "-d", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--threads"]),
  fd: new Set(["-e", "-E", "-t", "-d", "-S", "-o", "-j", "-c", "--extension", "--exclude", "--type", "--max-depth", "--size", "--owner", "--threads", "--color"]),
  du: new Set(["-d", "-B", "-t", "-X", "--max-depth", "--block-size", "--threshold", "--exclude"]),
  ls: new Set(["-w", "-I", "-T", "--width", "--ignore", "--tabsize"]),
  tree: new Set(["-L", "-P", "-I", "-o", "--charset", "--filelimit", "--timefmt"]),
};

/** The non-option words of `args` (after `--` all of them), skipping the values of the flags in `valued`; the flags seen are added to `seen`. */
function scanOperands(args: string[], valued: Set<string>, seen: Set<string>): string[] {
  const out: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (ended || !w.startsWith("-") || w === "-") out.push(w);
    else if (w === "--") ended = true;
    else {
      seen.add(w);
      if (valued.has(w)) i++;
    }
  }
  return out;
}

/** The search roots of a scan segment (`find`, a recursive grep, `rg`, `fd`, `du`, `ls -R`, `tree`): [] = the cwd; null = not a scan. */
function scanRoots(seg: ShellSegment): string[] | null {
  const verb = base(seg.program);
  const args = seg.argv;
  const seen = new Set<string>();
  if (verb === "find") {
    const roots: string[] = [];
    for (const w of args) {
      if (/^-[HLP]$/.test(w)) continue;
      if (w.startsWith("-") || w === "(" || w === "!") break;
      roots.push(w);
    }
    return roots;
  }
  if (verb === "grep" || verb === "egrep" || verb === "fgrep") {
    const ops = scanOperands(args, SCAN_VALUE_FLAGS.grep, seen);
    const rec = args.some((w, i) => /^-[A-Za-z]*[rR]/.test(w) || w === "--recursive" || w === "--dereference-recursive" || w === "--directories=recurse" || (w === "-d" && args[i + 1] === "recurse"));
    if (!rec) return null;
    return seen.has("-e") || seen.has("-f") || seen.has("--regexp") || seen.has("--file") || args.some((w) => /^--(?:regexp|file)=/.test(w)) ? ops : ops.slice(1);
  }
  if (verb === "rg") {
    const ops = scanOperands(args, SCAN_VALUE_FLAGS.rg, seen);
    return seen.has("-e") || seen.has("-f") || seen.has("--regexp") || seen.has("--file") || seen.has("--files") || args.some((w) => /^--(?:regexp|file)=/.test(w)) ? ops : ops.slice(1);
  }
  if (verb === "fd" || verb === "fdfind") {
    const cut = args.findIndex((w) => /^(?:-x|-X|--exec|--exec-batch)$/.test(w));
    const sp = args.flatMap((w, i) => (w === "--search-path" && args[i + 1] !== undefined ? [args[i + 1]] : w.startsWith('--search-path=') ? [w.slice(14)] : []));
    return [...scanOperands(cut >= 0 ? args.slice(0, cut) : args, SCAN_VALUE_FLAGS.fd, seen).slice(1), ...sp];
  }
  if (verb === "du") return scanOperands(args, SCAN_VALUE_FLAGS.du, seen);
  if (verb === "tree") return scanOperands(args, SCAN_VALUE_FLAGS.tree, seen);
  if (verb === "ls") {
    const ops = scanOperands(args, SCAN_VALUE_FLAGS.ls, seen);
    return args.some((w) => /^-[A-Za-z]*R/.test(w) || w === "--recursive") ? ops : null;
  }
  return null;
}

const MAX_GLOB = 200;

/** Every existing path a glob in any segment of `abs` expands to, at most MAX_GLOB (dot entries match too). */
function expandGlob(abs: string, p: typeof path.posix, win: boolean): string[] {
  const root = p.parse(abs).root;
  let cur = [root];
  for (const seg of abs.slice(root.length).split(win ? /[\\/]+/ : /\/+/).filter(Boolean)) {
    if (!/[*?[]/.test(seg)) {
      cur = cur.map((d) => p.join(d, seg));
      continue;
    }
    const next: string[] = [];
    for (const d of cur) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(d).slice(0, 500);
      } catch { /* not a directory: no match */ }
      for (const name of names) if ((name.startsWith(".") || !seg.startsWith(".")) && globSegMatch(seg, name)) next.push(p.join(d, name));
      if (next.length >= MAX_GLOB) break;
    }
    cur = next.slice(0, MAX_GLOB);
    if (!cur.length) break;
  }
  return cur;
}

/**
 * True when the search root `word` is the file system root, the home directory or a parent of it, or a parent of the workspace outside the allowed roots.
 * A glob is expanded against the file system and every match is judged, as the old layer did (no match: only the word itself, which names no directory).
 */
function scanRootBad(word: string, cwd: string, env: FloorEnv, ws: string, own: string[]): boolean {
  const platform = env.platform ?? process.platform;
  const win = platform === "win32";
  const p = px_(win);
  const globbed = /[*?[]/.test(word);
  const abs = resolveWord(word, cwd, env, globbed);
  if (abs === null) return false; // unknown: the walker cannot say, the gate's other steps decide
  // darwin's file system is case-insensitive too: compare through comparableFs
  const under = (x: string, root: string): boolean => {
    const a = comparableFs(platform, x);
    const r = comparableFs(platform, root);
    return a === r || a.startsWith(r.endsWith("/") ? r : `${r}/`);
  };
  const tmps = [os.tmpdir(), ...(win ? [] : ["/tmp"])];
  const allowed = [...tmps, ...own, ...(env.pkgRoot ? [env.pkgRoot] : []), ...(env.writeRoots ?? [])].flatMap((a) => [a, realDeep(a)].filter((x): x is string => !!x));
  const cands = new Set([abs, realDeep(abs)]);
  if (globbed) for (const m of expandGlob(abs, p, win)) [m, realDeep(m)].forEach((x) => cands.add(x));
  for (const c of cands) {
    if (!c) continue;
    const x = p.resolve(c);
    if (p.parse(x).root === x || (env.home && under(env.home, x))) return true;
    if (ws && under(ws, x) && !under(x, ws) && !allowed.some((a) => under(x, a))) return true;
  }
  return false;
}

/** `danger-fs-scan` (judge-first): a recursive read rooted at `/`, the home directory or a parent of the workspace; a relative or in-worktree root is none. */
function fsScanFloor(seg: ShellSegment, env: FloorEnv): FloorHit | null {
  const roots = scanRoots(seg);
  if (!roots) return null;
  return scanHit(roots.length ? roots : ["."], seg.cwd ?? env.cwd, seg.program, env);
}

/** `floor-fs-scan` for the Pi `find` and `grep` tools: their `path` (default: the cwd) is the search root. */
export function scanToolFloor(tool: string, input: Record<string, unknown>, cwd: string, env: FloorEnv): FloorHit | null {
  if (tool !== "find" && tool !== "grep") return null;
  const root = typeof input.path === "string" && input.path ? input.path : ".";
  return scanHit([root], cwd, tool, env);
}

function scanHit(roots: string[], cwd: string, program: string, env: FloorEnv): FloorHit | null {
  const ws = workspaceOf(env.cwd).root;
  const own = env.scratch ?? [];
  const bad = roots.find((r) => scanRootBad(r, cwd, env, ws, own));
  if (bad === undefined) return null;
  const shown = bad === "." ? cwd : bad;
  return judgeHit("fs-scan", `A whole-filesystem scan: the search root '${cutFragment(shown)}' is /, the home directory or a parent of the workspace (worktree ${ws}).`, `${program} ${shown}`);
}

// ------------------------------------------------------------------ built-in command deny (round 2 step 2)

/** The built-in command patterns the floor matches (the credential reads; the privilege and download-shell entries are owned by other rules, below). */
export const BUILTIN_DENY_INLINE: readonly string[] = [
  "sudo *", "doas *",
  "curl * | sh *", "curl * | bash *", "curl * | zsh *", "curl * | sudo *",
  "wget * | sh *", "wget * | bash *", "wget * | zsh *", "wget * | sudo *",
  "gh auth token*", "gh auth status --show-token*",
  "git credential fill*",
  "security find-generic-password* -w*", "security find-generic-password* -g*", "security find-internet-password*",
];

/** Patterns another rule owns: privilege escalation (floor-privilege), a download piped into a shell (floor-download-shell), `git credential fill` (the danger-git label the judge decides). */
const DENY_OWNED_ELSEWHERE = (pat: string): boolean => /^(?:sudo|doas) /.test(pat) || pat.includes(" | ") || pat.startsWith("git credential fill");

const BUILTIN_DENY_PATTERNS: readonly string[] = BUILTIN_DENY_INLINE.filter((p) => !DENY_OWNED_ELSEWHERE(p));

const DEFAULT_PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `floor-builtin-deny`: `text` (one segment, or one statement of the powershell tool) matches a built-in command pattern. */
function builtinDeny(text: string, env: FloorEnv, ps: boolean): FloorHit | null {
  const home = env.home ?? "";
  const pat = BUILTIN_DENY_PATTERNS.find((p) => wildcardRegExp(p, { home, ignoreCase: ps, foldSeparators: false }).test(text.trim()));
  return pat === undefined ? null : hit("builtin-deny", `This command (matching '${pat}') reads or prints a credential. Use the tool's own configured login instead; ask the user when a token is needed.`, text);
}

/**
 * The built-in deny for a line of the powershell tool: the line is split into the units the old layer matched its `bash.deny` patterns against
 * (psunits.ts: the PowerShell lexer, with the `pwsh -c` / `cmd /c` scripts, `$( )` substitutions, `.exe` and path prefix handled there).
 * A statement that only mentions the words in a string (`Write-Output "gh auth token"`) starts with its own program and does not match.
 */
function psBuiltinDeny(line: string, env: FloorEnv): FloorHit | null {
  for (const text of psUnitTexts(line)) {
    const bd = builtinDeny(text, env, true);
    if (bd) return bd;
  }
  return null;
}

const PATTERN_PROGS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "nawk"]);

/**
 * Indexes into `seg.argv` of the pattern operands of the search programs (A4): the grep/rg pattern and `-e` values, and the sed script or awk
 * program when it can only read. `-f`/`--file` values and every other operand stay paths.
 */
function searchPatterns(seg: ShellSegment, prog: string): Set<number> {
  if (!PATTERN_PROGS.has(prog)) return new Set();
  return new Set(nonPathArgs([seg.program, ...seg.argv], new Set()).map((i) => i - 1).filter((i) => i >= 0));
}

/** A curl `-F` value (`f=@a.json, .env`): its file list may hold a space, so the word is read by `secretPath` although it holds whitespace. */
const FORM_LIST = /^[^@/\s=]+=[@<]/;

/** A word that is text or a pattern, not a path: it holds whitespace (and does not start like a path), or an alternation or group character. */
function dataWord(w: string): boolean {
  return (/\s/.test(w) && !/^(?:~|\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(w)) || /[|()]/.test(w);
}

// ------------------------------------------------------------------ terminal injection (r79 Addendum S3)

const KEY_ANY_CASE = /^(?:enter|return|escape|esc|tab|bspace|backspace|pageup|pagedown|pgup|pgdn|c-.|m-.|ctrl-.+|alt-.+|kp.*|f[0-9]{1,2})$/i;
const KEY_CAPITAL = new Set(["Space", "Up", "Down", "Left", "Right", "Home", "End", "Delete", "Insert"]);

/** The typed payload of a terminal-injection command (`herdr pane send-keys|send-text`, `tmux send-keys`, `osascript ... keystroke`), or null. */
export function injection(seg: ShellSegment, prog: string): { words: string[]; text: string } | null {
  const a = seg.argv;
  if (prog === "herdr") {
    const i = a.findIndex((w) => w === "send-keys" || w === "send-text");
    if (i < 0 || a[0] !== "pane") return null;
    const pos = a.slice(i + 1).filter((w) => !w.startsWith("--"));
    const words = pos.slice(1);
    return { words, text: words.join(" ") };
  }
  if (prog === "tmux") {
    const i = a.indexOf("send-keys");
    if (i < 0 && !a.includes("send")) return null;
    const words: string[] = [];
    const rest = a.slice((i < 0 ? a.indexOf("send") : i) + 1);
    for (let k = 0; k < rest.length; k++) {
      if (/^-[tNcl]$/.test(rest[k]) && rest[k] !== "-l") k++;
      else if (!rest[k].startsWith("-") || rest[k] === "-") words.push(rest[k]);
    }
    return { words, text: words.join(" ") };
  }
  if (prog === "osascript") {
    const joined = a.join("\n");
    if (!/keystroke|key code/i.test(joined)) return null;
    const words: string[] = [];
    for (const m of joined.matchAll(/keystroke\s+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/gi)) words.push(m[1].replace(/^(["'])(.*)\1$/s, "$2"));
    if (/key code/i.test(joined)) words.push("Enter");
    return { words, text: words.join(" ") };
  }
  return null;
}

/** A payload typed into a terminal goes to the judge first when a line starts with `/` (a slash command), it is 2 characters or fewer (a dialog answer) or a token is a key name. */
function injectFloor(seg: ShellSegment, prog: string): FloorHit | null {
  const inj = injection(seg, prog);
  if (!inj) return null;
  const tokens = inj.words.flatMap((w) => w.split(/\s+/)).filter(Boolean);
  const slashLine = inj.words.some((w) => w.split(/\r?\n|\\n/).some((l) => /^\s*\//.test(l)));
  const key = tokens.find((t) => KEY_ANY_CASE.test(t) || KEY_CAPITAL.has(t));
  if (!slashLine && !key && inj.text.trim().length > 2) return null;
  const why = slashLine ? "a line that starts with `/` is a slash command" : key ? `'${key}' is a key name` : "a payload of 2 characters or fewer answers a dialog";
  return judgeHit("inject", `Typing into another terminal pane: ${why}. Such input drives dialogs and commands of the other session.`);
}

function publishFloor(prog: string, a: string[]): string | null {
  const sub = a.find((w) => !w.startsWith("-"));
  if (["npm", "pnpm", "yarn", "bun"].includes(prog) && (a.some((w) => w === "publish") || /^(unpublish|deprecate)$/.test(sub ?? ""))) return `\`${prog} ${a.includes("publish") ? "publish" : sub}\``;
  if ((prog === "cargo" || prog === "poetry" || prog === "uv" || prog === "hatch" || prog === "flit") && sub === "publish") return `\`${prog} publish\``;
  if (prog === "twine" && sub === "upload") return "`twine upload`";
  if (/^python[0-9.]*$/.test(prog) && a.includes("twine") && a.includes("upload")) return "`python -m twine upload`";
  if (prog === "gem" && sub === "push") return "`gem push`";
  if (prog === "dotnet" && a.includes("nuget") && a.includes("push")) return "`dotnet nuget push`";
  if ((prog === "docker" || prog === "podman") && sub === "push") return `\`${prog} push\``;
  if ((prog === "vsce" || prog === "ovsx") && sub === "publish") return `\`${prog} publish\``;
  if (prog === "gh" && a[0] === "release" && /^(create|upload|edit|delete)$/.test(a[1] ?? "")) return `\`gh release ${a[1]}\``;
  return null;
}

const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.config\/gcloud|\.config\/gh|\.kube\/config|\.docker\/config\.json|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc)(\/|$)/i;
/** The key-file name globs (`config/secret-paths.json`, also read by scripts/foreman_sync.py); unreadable: the inline list, which fails closed. */
export const SECRET_PATHS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "secret-paths.json");
const SECRET_GLOBS_INLINE = ["*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*"];
function loadSecretGlobs(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(SECRET_PATHS_FILE, "utf8")) as unknown;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "")) return v as string[];
  } catch {
    // fall through to the inline list
  }
  return SECRET_GLOBS_INLINE;
}
export const SECRET_GLOBS: readonly string[] = loadSecretGlobs();
const SECRET_FILE = new RegExp(`(^|/)(${SECRET_GLOBS.map((g) => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})$`, "i");

/** A secret or key path (read or write), by the path alone. Bare names (no separator, no `~`) are not judged here. */
const SECRET_EXTRA = /(^|\/)(\.config\/hub|\.config\/glab-cli|\.pi\/extensions\/pi-permission-system|\.claude\/\.credentials\.json|credentials(\.[^/]*)?)(\/|$)/i;
/** Every literal name `SECRET_DIRS`, `SECRET_EXTRA`, `.git/config` and the auth file compare a segment with (the win32 8.3 short-name fold reads a short name as one of these). */
const SECRET_NAMES = [".ssh", ".gnupg", ".aws", ".azure", ".config", "gcloud", "gh", "hub", "glab-cli", ".kube", "config", ".docker", "config.json", ".git-credentials", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git", "auth.json", ".claude", ".credentials.json", "credentials", ".pi", "agent", "extensions", "pi-permission-system"];
const ENV_FILE = /(^|\/)([^/]*\.env|\.env\.[^/]+)$/i;
/** A bare (separator-free) word is a secret only when it is a dotenv name itself, so `process.env` or `app.env` as an argument is not judged. `.envrc` is not a secret. */
const ENV_BARE = /^\.env(\.[^/]+)?$/i;
const GIT_CONFIG_FILE = /(^|\/)\.git\/config$/i;
const ENV_EXEMPT = /\.env\.(example|sample|template)$/i;

/** The OpenSSH public key types (certificates included) a `*.pub` file may start with. */
const SSH_PUB_TYPES = new Set(["ssh-rsa", "ssh-dss", "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa-cert-v01@openssh.com", "ssh-ed25519-cert-v01@openssh.com", "ecdsa-sha2-nistp256-cert-v01@openssh.com", "ecdsa-sha2-nistp384-cert-v01@openssh.com", "ecdsa-sha2-nistp521-cert-v01@openssh.com",
  "sk-ssh-ed25519-cert-v01@openssh.com", "sk-ecdsa-sha2-nistp256-cert-v01@openssh.com"]);
const SSH_PUB_MAX = 16 * 1024;

/**
 * Whether `word` names an SSH public key directly in `<home>/.ssh/`: lexically (parent is exactly `<home>/.ssh`), after symlinks (the real file is a `*.pub`
 * directly in the real `~/.ssh`) and by content (a regular file of at most 16 KiB whose every line starts with an OpenSSH public key type). Anything
 * else, a missing file included, is false. Only a read may use it (`secretPath(..., read)`): a write to such a file stays a secret-path deny.
 */
export function sshPublicKey(word: string, env: FloorEnv): boolean {
  try {
    const win = (env.platform ?? process.platform) === "win32";
    let x = slash(word.replace(/^(["'])(.*)\1$/, "$2"));
    // the Windows spellings of the profile (the `$env:USERPROFILE` form) are the home dir
    if (win && env.home) x = x.replace(/^(?:%USERPROFILE%|\$env:USERPROFILE|\$\{env:USERPROFILE\})(?=\/|$)/i, () => slash(env.home!));
    if (!env.home || /[$`*?[{%]/.test(x.replace(/^\$\{?HOME\}?/, ""))) return false;
    const abs = resolveWord(x, env.cwd, env);
    if (abs === null) return false;
    const px = px_(win);
    const key = (p: string): string => (foldFor(env) ? slash(p).toLowerCase() : slash(p));
    const ssh = px.join(env.home, ".ssh");
    if (!px.basename(abs).endsWith(".pub") || px.basename(abs) === ".pub" || key(px.dirname(abs)) !== key(ssh)) return false;
    const file = slash(abs);
    const real = fs.realpathSync(file);
    const realSsh = fs.realpathSync(slash(ssh));
    if (!path.basename(real).endsWith(".pub") || (foldFor(env) ? path.dirname(real).toLowerCase() !== realSsh.toLowerCase() : path.dirname(real) !== realSsh)) return false;
    const fd = fs.openSync(real, "r");
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size === 0 || st.size > SSH_PUB_MAX) return false;
      const buf = Buffer.alloc(st.size);
      if (fs.readSync(fd, buf, 0, st.size, 0) !== st.size) return false;
      const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
      return lines.length > 0 && lines.every((l) => SSH_PUB_TYPES.has(l.trim().split(/\s+/)[0]));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * A read-only child in a round (`env.readOnlyChild`) may read the `.git/config` of a copy inside its own scratch dir (a clone it made there): the word is a
 * literal path (absolute, or relative to the known `env.segCwd`; no `..`, variable, glob or `~`), matches no other secret pattern, and its real path lies under the real
 * path of one of `env.scratch`. Only a read may use it (the callers: `secretPath` with `read`, and the read question's token check, which resolves a relative token by its segments' cwd).
 */
export function scratchGitConfigRead(word: string, env: FloorEnv): boolean {
  try {
    if (!env.readOnlyChild || !env.scratch?.length) return false;
    const w = slash(word.replace(/^(["'])(.*)\1$/, "$2"));
    const m = /^-{1,2}[\w-]+=(.+)$/.exec(w);
    const x = m ? m[1] : w;
    if (!GIT_CONFIG_FILE.test(x) || /[$`*?[{~]/.test(x) || x.split("/").includes("..")) return false;
    if (SECRET_DIRS.test(x) || SECRET_FILE.test(x) || SECRET_EXTRA.test(x) || (ENV_FILE.test(x) && !ENV_EXEMPT.test(x))) return false;
    const plat = env.platform ?? process.platform;
    if (shortNameSpellings(plat, x, SECRET_NAMES).some((s) => SECRET_DIRS.test(s) || SECRET_EXTRA.test(s))) return false;
    const px = px_(plat === "win32");
    const abs = px.isAbsolute(x) ? px.normalize(x) : env.segCwd ? px.resolve(env.segCwd, x) : null;
    if (abs === null) return false;
    const mine = formsOf(abs, env);
    if (authFiles(env).some((a) => formsOf(a, env).some((f) => mine.includes(f)))) return false;
    const real = realDeep(abs);
    if (real === null) return false;
    return env.scratch.some((r) => insideRoot(real, realDeep(r) ?? r, plat));
  } catch {
    return false;
  }
}

/** `read`: the word is only read (a read tool's path, a read-only program's operand, a `<` redirect); then an SSH public key in `~/.ssh` is no secret. */
export function secretPath(word: string, env: FloorEnv, read = false): FloorHit | null {
  const w = slash(word.replace(/^(["'])(.*)\1$/, "$2"));
  // curl's `@file` forms: `@.env`, `-d@.env`, `--data=@.env`, `f=@.env`, `name@.env` read the file after the first `@` (a prefix with a `/` is a path itself)
  // and `-F` form values: `f=@.env;type=x`, `f=@.env\;filename=y` (the `;` parameters are no part of the file), `f=<.env` (the file's content as the value)
  const at = /^([^@/\s]*)@(.+)$/.exec(w) ?? /^[^@/\s=]+=<(.+)$/.exec(w);
  if (at) {
    const unq = (f: string): string => f.trim().replace(/[\\/]?;.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
    // a `-F` value may list several files: `f=@a.json,.env` (only the form shape; `-d@a,b` is one name); split on `,` first, then strip each part's `;…` parameters
    for (const f of /=[@<]/.test(w) ? at[at.length - 1].split(",").map(unq) : [unq(at[at.length - 1])]) {
      const h = secretPath(f, env, read);
      if (h) return h;
    }
  }
  const m = /^-{1,2}[\w-]+=(.+)$/.exec(w);
  const x = m ? m[1] : w;
  const pathLike = x.includes("/") || x.startsWith("~");
  const bareEnv = !pathLike && ENV_BARE.test(x) && !ENV_EXEMPT.test(x);
  if (pathLike && read && x.endsWith('.pub') && sshPublicKey(x, env)) return null;
  if (pathLike && read && scratchGitConfigRead(x, env)) return null;
  let bad = bareEnv || (pathLike && (GIT_CONFIG_FILE.test(x) || SECRET_DIRS.test(x) || SECRET_FILE.test(x) || SECRET_EXTRA.test(x) || (ENV_FILE.test(x) && !ENV_EXEMPT.test(x))));
  // win32: a short-name segment (`.ssh` as `SSH~1`) that fits a secret name is judged as that name
  const shorts = pathLike ? shortNameSpellings(env.platform ?? process.platform, x, SECRET_NAMES) : [];
  if (!bad) bad = shorts.some((s) => GIT_CONFIG_FILE.test(s) || SECRET_DIRS.test(s) || SECRET_EXTRA.test(s));
  if (!bad && pathLike) {
    for (const v of [x, ...shorts]) {
      const abs = expandWord(v, env);
      if (abs === null) continue;
      const mine = formsOf(abs, env);
      if (authFiles(env).some((a) => formsOf(a, env).some((f) => mine.includes(f)))) bad = true;
    }
  }
  if (!bad) return null;
  return hit("secret-path", `'${x}' is a secret or key path (SSH, GnuPG, cloud or registry credentials, private keys, Pi's auth file). Never read or write it; ask the user for the value you need.`, word);
}

// ------------------------------------------------------------------ PowerShell units, deletes with an unknown target (plan PR B, O4)

const PS_REMOVERS = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
/** `-Recurse` (any prefix of it, also `-Recurse:$true`), a cmd switch cluster holding `s` (`/s`, `/s/q`, `/q/s`), and the `rm`-style `-r`, `-rf`, `-fr`. */
const PS_RECURSE = /^(?:-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?(?::\S*)?|\/(?:[a-z]\/)*s(?:\/[a-z])*|-rf|-fr)$/i;
const CMD_SWITCHES = /^\/[a-z](?:\/[a-z])*(?::\S*)?$/i;
const PS_CD = new Set(["cd", "chdir", "sl", "set-location", "pushd", "push-location"]);
const PS_DOWNLOAD = /\b(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|start-bitstransfer|webclient)\b/i;
const PS_ENCODED = /^-e(?:c|nc(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?$/i;

/**
 * The PowerShell units of a line (the lexer of psunits.ts: one text per unit, the scripts of `pwsh -c` and `cmd /c` units and `$( )` substitutions included).
 * A text that still holds a separator is a whole-line or pipeline text, not a unit.
 */
function psUnits(line: string): string[][] {
  // `${env:X}` is read as `$env:X` before lexing (the lexer cuts a braced name into a block); a text substitution, the lexer is unchanged
  return psUnitTexts(line.replace(/\$\{env:(\w+)\}/gi, "$$env:$1")).filter((t) => !/[;|&\n]/.test(t.replace(/'[^']*'|"[^"]*"/g, ""))).map((t) => t.trim().split(/\s+/).filter(Boolean)).filter((w) => w.length > 0);
}

/** The line is read through the PowerShell units: the powershell tool (one segment, program `powershell`) or a bash line with a `pwsh`, `powershell` or `cmd` segment. */
const foreignSegments = (segments: ShellSegment[]): boolean => segments.some((s) => ["pwsh", "powershell", "cmd"].includes(base(s.program)));

/** An operand with the environment words a PowerShell or cmd unit uses replaced by fixed text: the floor env's home and `C:\Windows`; reads no environment, same on every OS. */
function psOperand(word: string, env: FloorEnv): string {
  // `FileSystem::C:\x` and `\\?\C:\x` name the same path as `C:\x`
  const w = word.replace(/^(["'])(.*)\1$/, "$2").replace(/^(?:[\w.]+\\)?filesystem::/i, "").replace(/^\\\\\?\\/, "");
  const home = env.home ? env.home : null;
  const homed = home ? w.replace(/^(?:~|\$home|\$env:userprofile|\$\{env:userprofile\}|%userprofile%)(?=[\\/]|$)/i, () => home) : w;
  return homed.replace(/^(?:\$env:systemroot|\$\{env:systemroot\}|%systemroot%|\$env:windir|\$\{env:windir\}|%windir%)(?=[\\/]|$)/i, "C:\\Windows");
}

/** `-Recurse` as a word: not `-Recurse:$false` or `-Recurse:0`. */
const psRecurses = (w: string): boolean => PS_RECURSE.test(w) && !/^-\w+:(?:\$false|0)$/i.test(w);

/** A Remove-Item parameter that names the path (`-Path`, `-LiteralPath`, any prefix of them, `-LP`, `-PSPath`). */
const psPathParam = (name: string): boolean => name !== "" && ("path".startsWith(name) || "literalpath".startsWith(name) || name === "lp" || name === "pspath");

/** The arguments `iex` runs: the words after `iex`, less a leading `-Command` (any other parameter is not Invoke-Expression's: `iex -S mix` is Elixir's shell). */
function iexArgs(words: string[]): string[] {
  const rest = words.slice(1);
  const flag = /^-(\w*)/.exec(rest[0] ?? "");
  if (!flag) return rest;
  return flag[1] !== "" && "command".startsWith(flag[1].toLowerCase()) ? rest.slice(1) : [];
}

/** The literal string `iex` runs (`iex 'Remove-Item ...'`, or a double-quoted one without `$` or a backtick), else null. */
function iexBody(words: string[]): string | null {
  const arg = iexArgs(words).join(" ");
  const single = /^'((?:[^']|'')*)'$/.exec(arg);
  if (single) return single[1].replace(/''/g, "'");
  return /^"([^"`$]*)"$/.exec(arg)?.[1] ?? null;
}

/** The remover words of a unit: the operands (flags dropped; `-Path:x` and a comma list split) when it is a PowerShell or cmd delete with a recursive flag, else null. */
function psRecursiveDelete(words: string[]): string[] | null {
  if (!PS_REMOVERS.has(base(words[0]))) return null;
  const rest = words.slice(1);
  if (!rest.some(psRecurses)) return null;
  const ops: string[] = [];
  for (const w of rest) {
    const named = /^-([a-z]+):(.*)$/i.exec(w);
    if (named) {
      if (psPathParam(named[1].toLowerCase())) ops.push(...named[2].split(",").filter(Boolean).concat(named[2] === "" ? [""] : []));
      continue;
    }
    if (!w.startsWith('-') && !CMD_SWITCHES.test(w)) ops.push(...(w.includes(",") ? w.split(",").filter(Boolean) : [w]));
  }
  return ops;
}

/**
 * The floors of the PowerShell units of a line (O4): a recursive delete whose target is the home directory, the file system root or a system folder
 * (`systemRemoval`, after the fixed substitution of psOperand) is `rm-system`; `Format-Volume`, `Clear-Disk`, `Remove-Partition`, `diskpart` and `format X:` are `disk`.
 */
function psUnitFloors(line: string, env: FloorEnv, depth = 0): FloorHit | null {
  const diskRe = RAW.find((r) => r.name === "disk")!;
  for (const words of psUnits(line)) {
    const text = words.join(" ");
    if (diskRe.re.test(text) || /^format(?:\.exe|\.com)?\s+[a-z]:/i.test(text)) return hit("disk", diskRe.reason, text);
    if (/^(?:iex|invoke-expression)$/.test(base(words[0]))) {
      // `iex` of a literal string runs that string's units; of a download, unreviewed code
      const body = iexBody(words);
      if (body !== null) {
        const inner = depth < MAX_DEPTH ? psUnitFloors(body, env, depth + 1) : null;
        if (inner) return inner;
      } else if (PS_DOWNLOAD.test(text)) return hit("download-shell", RAW.find((r) => r.name === "download-shell")!.reason, text);
    }
    const ops = psRecursiveDelete(words);
    if (!ops) continue;
    const subst = ops.map((o) => psOperand(o, env));
    // the unit text lost its quotes: a name with a space (`Program Files`) is also read as the rest of the words
    const sys = [...subst, subst.join(" ")].find((o) => systemRemoval(o, env));
    if (sys !== undefined) return hit("rm-system", `Removing '${sys}' (the file system root, the home directory or a system directory) is never allowed. Remove specific files inside the worktree, scratch or /tmp.`, text);
  }
  return null;
}

/**
 * A literal recursive PowerShell or cmd delete outside the worktree, scratch and /tmp is judge-first (the harness cannot read where a PowerShell delete lands);
 * variable operands are `unknownTargetDelete`, home, root and system targets `psUnitFloors`.
 */
function psOutsideDelete(line: string, env: FloorEnv): FloorHit | null {
  for (const words of psUnits(line)) {
    const ops = psRecursiveDelete(words);
    if (!ops) continue;
    const out = ops.map((o) => psOperand(o, env)).find((o) => !/[$%@]/.test(o) && (outside(o, env.cwd, env) || ((env.platform ?? process.platform) !== "win32" && /^[a-z]:[\\/]/i.test(o))));
    if (out !== undefined) return judgeHit("delete-unknown-target", `A recursive PowerShell or cmd delete of '${cutFragment(out)}' outside the worktree, your scratch dir and /tmp.`, words.join(" "));
  }
  return null;
}

/** A label for the judge to look at first (no floor): a delete whose target the harness cannot read. */
export interface UnknownDelete {
  name: "danger-delete-unknown-target";
  reason: string;
  /** The forms the old Python check refused: `lineFloors` hands them to the judge itself (a judge-first hit that no built-in allow clears); the other forms keep the label only. */
  floor: boolean;
  /** The forms the old check asked on (a PowerShell form it could not read); judge-first like `floor`. */
  ask?: boolean;
}

const UNKNOWN_DELETE = (why: string, floor = true): UnknownDelete => ({ name: "danger-delete-unknown-target", reason: `a delete with an unknown target (${why})`, floor });
const RM_RECURSIVE = /^-[A-Za-z]*[rR]|^--recursive$/;
/** A command word that holds an expansion and names no program: `$X`, `"$CMD"` (a word with a literal basename after the expansion, `$V/bin/pip`, reaches here as that program). */
const varCommandWord = (p: string): boolean => /[$`]/.test(p) && !/[=\s]/.test(p);
/** A recursive flag behind a command word that is itself a variable: short clusters only (`-rf`, `-R`), so a PowerShell parameter like `-Force` is none. */
const VAR_CMD_RECURSIVE = /^-(?=[A-Za-z]{1,4}$)[A-Za-z]*[rR]|^--recursive$/;
const EXEC_WORDS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** A remover word of a string a runner reads as code with a recursive flag among the words up to the next `;`, `&` or `|` (a later command's flag is none). */
function removerInString(text: string): boolean {
  return text.split(/[;&|\n]+/).some((part) => {
    const words = part.split(/[\s()$"'`{}]+/);
    return words.some((w, i) => REMOVERS.has(base(w)) && words.slice(i + 1).some((x) => RM_RECURSIVE.test(x)));
  });
}

/**
 * The judge-first label "delete with unknown target" (plan T2, from destructive_guard.py), read from the parsed line only: a recursive remover whose operand is
 * unresolved (a variable, a substitution, an empty word), whose glob has no readable prefix or whose cwd is unresolved (a `cd` into a variable) or that runs
 * under `xargs` or `find -exec`; a command word that is a variable with a recursive flag behind it; `git clean` with a variable operand; and, for a line read
 * through the PowerShell units, any recursive delete word (the harness cannot read where it deletes), `-EncodedCommand` and `iex` of a computed string.
 * A resolved variable or a glob inside the write area is none: the closed grammar of shellast.ts has already replaced it (`$FOREMAN_SCRATCH`, same-line assignments).
 * No floor: the delete floors (`rm-system`, `delete-outside`) were judged before this is asked.
 */
export function unknownTargetDelete(text: string, segments: ShellSegment[], env: FloorEnv): UnknownDelete | null {
  const hits = unknownTargetDeletes(text, segments, env);
  // a floor-eligible hit anywhere on the line wins over a label-only one
  return hits.find((h) => h.floor) ?? hits[0] ?? null;
}

/** The judge-first hit of the label's predicate (`danger-delete-unknown-target`): a delete the old check refused or asked on, whose target cannot be read. */
function unknownFloor(text: string, segments: ShellSegment[], env: FloorEnv): FloorHit | null {
  const hits = unknownTargetDeletes(text, segments, env);
  const h = hits.find((x) => x.floor) ?? hits.find((x) => x.ask);
  return h ? judgeHit("delete-unknown-target", `The target of this delete cannot be read (${h.reason}).`, text) : null;
}

function unknownTargetDeletes(text: string, segments: ShellSegment[], env: FloorEnv): UnknownDelete[] {
  const hits: UnknownDelete[] = [];
  const win = (env.platform ?? process.platform) === "win32";
  for (const s of segments) {
    const prog = base(s.program);
    const argv = s.argv;
    if (prog === "rm" && argv.some((w) => RM_RECURSIVE.test(w))) {
      if (s.wrappers.some((w) => base(w) === "xargs")) hits.push(UNKNOWN_DELETE("a remover under xargs"));
      const ops = deleteOperands(s, prog);
      if ((s.opaque === "unresolved_var" || s.opaque === "process_substitution") && !homeSpelling(s)) hits.push(UNKNOWN_DELETE("an operand is a variable or a substitution"));
      if (ops.some((w) => w === "")) hits.push(UNKNOWN_DELETE("an operand is empty"));
      for (const w of ops) {
        if (/[$`]/.test(w) && !/^\$\{?HOME\}?(?:[\\/]|$)/.test(w)) hits.push(UNKNOWN_DELETE(`'${cutFragment(w)}' holds a variable`));
        const abs = px_(win).isAbsolute(w) || /^(?:~|\$HOME|\$\{HOME\})(?:[\\/]|$)/.test(w);
        if (s.cwd === null && !abs) hits.push(UNKNOWN_DELETE(`'${cutFragment(w)}' is relative to a directory changed through a variable`));
        // a bare glob (`*`) names the working directory: known and inside the roots here (an unknown cwd is the hit above, one outside the roots stays refused)
        if (/[*?[{]/.test(w) && !(!abs && s.cwd !== null && /^[*?[{]/.test(w) && !outside(".", s.cwd, env)) && resolveWord(w, s.cwd ?? env.cwd, env) === null) hits.push(UNKNOWN_DELETE(`the glob '${cutFragment(w)}' has no readable directory`));
      }
    }
    if (prog === "find" && argv.includes("-delete") && deleteOperands(s, prog).some((w) => w === "" || /[$`]/.test(w))) hits.push(UNKNOWN_DELETE("find -delete from a start path that is a variable"));
    if (prog === "find" && argv.includes("-delete") && s.cwd === null && deleteOperands(s, prog).every((w) => !px_(win).isAbsolute(w) && !w.startsWith("~"))) hits.push(UNKNOWN_DELETE("find -delete from a directory changed through a variable"));
    if (prog === "shred" && s.wrappers.some((w) => base(w) === "xargs")) hits.push(UNKNOWN_DELETE("a remover under xargs"));
    if (prog === "shred" && deleteOperands(s, prog).some((w) => w === "" || /[$`]/.test(w))) hits.push(UNKNOWN_DELETE("shred of a variable or empty operand"));
    if (prog === "find" && findExecRemoves(argv)) hits.push(UNKNOWN_DELETE("a remover under find -exec"));
    // `eval "rm -rf $D"`, `sh -c "rm -rf $D"`: the string is built at run time, so its words are scanned as a runner's string under find -exec is
    if (s.opaque === "nonliteral_script" && removerInString([s.program, ...argv].join(" "))) hits.push(UNKNOWN_DELETE("a remover inside a script string built at run time"));
    if (varCommandWord(s.program) && argv.some((w) => VAR_CMD_RECURSIVE.test(w))) hits.push(UNKNOWN_DELETE("the command word is a variable with a recursive flag"));
    if (prog === "git" && argv.some((w) => /[$`]/.test(w) || w === "")) {
      const call = gitCall(s, env);
      if (call?.sub === "clean") hits.push(UNKNOWN_DELETE("git clean with a variable operand"));
    }
  }
  if (foreignSegments(segments)) hits.push(...psUnknownDeletes(text, 0));
  return hits;
}

/** The PowerShell and cmd forms of `unknownTargetDeletes`, read from the units of `text` (the literal string of an `iex` is read as units too). */
function psUnknownDeletes(text: string, depth: number): UnknownDelete[] {
  const hits: UnknownDelete[] = [];
  const units = psUnits(text);
  const recursiveElsewhere = units.some((w) => w.slice(1).some(psRecurses));
  // the old check took any `cd` (`Set-Location`, `Push-Location` ...) as the end of a known directory: a relative target after one names a directory nobody can point at
  let moved = false;
  const literalBodies = new Set(units.filter((w) => /^(?:iex|invoke-expression)$/.test(base(w[0]))).map(iexBody).filter((b): b is string => b !== null));
  for (const words of units) {
    const p = base(words[0]);
    const ops = psRecursiveDelete(words);
    // a floor only where a word of the delete is a variable (`-Recurse:$true` and `/s/q` are switches), is empty, or is relative to a changed directory; a literal PowerShell delete keeps the label
    if (ops) {
      const variable = ops.some((o) => /[$%]/.test(o)) || words.slice(1).some((x) => /^-(?:path|literalpath|lp|pspath):\S*[$%]/i.test(x));
      const empty = ops.some((o) => o.replace(/^(["'])(.*)\1$/, "$2") === "");
      hits.push(UNKNOWN_DELETE("a recursive PowerShell or cmd delete: the harness cannot read where it deletes", variable || empty));
      if (moved) {
        const rel = ops.map((o) => o.replace(/^(["'])(.*)\1$/, "$2")).filter((o) => !/[$%]/.test(o) && !o.startsWith("~") && !slash(o).startsWith("/"));
        if (rel.some((o) => ["*", ".", ".."].includes(slash(o).replace(/\/$/, "") || o))) hits.push(UNKNOWN_DELETE("a recursive PowerShell delete of the whole directory after a directory change"));
        else if (rel.length) hits.push({ ...UNKNOWN_DELETE("a relative recursive PowerShell delete after a directory change", false), ask: true });
      }
    }
    if (PS_REMOVERS.has(p)) {
      const rest = words.slice(1);
      if (/^(?:remove-item|ri)$/i.test(p) && rest.some((x) => /^@\w+$/.test(x))) hits.push({ ...UNKNOWN_DELETE("Remove-Item takes a splatted argument list", false), ask: true });
      if (p !== "rm" && recursiveElsewhere && !rest.some((x) => !x.startsWith('-') && !CMD_SWITCHES.test(x))) hits.push({ ...UNKNOWN_DELETE("a delete fed by a recursive listing: the harness cannot read where it deletes", false), ask: true });
    }
    if ((p === "pwsh" || p === "powershell") && words.slice(1, ((i) => (i < 0 ? words.length : i))(words.findIndex((w) => /^-c(?:ommand)?$/i.test(w)))).some((w) => PS_ENCODED.test(w))) hits.push({ ...UNKNOWN_DELETE("an encoded PowerShell command cannot be read", false), ask: true });
    if ((p === "pwsh" || p === "powershell") && depth < MAX_DEPTH) {
      const c = words.findIndex((w) => /^-c(?:ommand)?$/i.test(w));
      if (c > 0 && c < words.length - 1) hits.push(...psUnknownDeletes(words.slice(c + 1).join(" "), depth + 1));
    }
    if (p === "iex" || p === "invoke-expression") {
      const body = iexBody(words);
      // the lexer also yields the unit with its quotes taken off: that is the literal string above, not a computed one
      if (body === null && literalBodies.has(iexArgs(words).join(" "))) continue;
      if (body !== null) {
        if (depth < MAX_DEPTH) hits.push(...psUnknownDeletes(body, depth + 1));
      } else if (iexArgs(words).length > 0 && !PS_DOWNLOAD.test(words.join(" "))) hits.push({ ...UNKNOWN_DELETE("iex of a computed string cannot be read", false), ask: true });
    }
    if (PS_CD.has(p)) moved = true;
  }
  return hits;
}

// ------------------------------------------------------------------ recursing paths (PR B2): the checks of the old delete check, one function for every nested command

/** Where a nested command runs: this machine, another one over `ssh` (a recursive `rm` there runs: the owner's exception), or in a container (every kind refused). */
type Where = "local" | "ssh" | "container";

/**
 * The words the old check read as the command of an `ssh`, `docker`/`podman` `exec`/`run` or `kubectl exec` segment: everything after the program (and the verb), the
 * target host, container or pod and the options included, as it joined them (`_check_remote`). So the first command of the joined text is named by the target, and
 * only a later command (`ssh host 'ls; shred /x'`) was read: the bare `ssh host shred /x` was never refused, and stays running.
 */
export function remoteCommand(seg: ShellSegment, prog: string): { words: string[]; where: Where } | null {
  const a = seg.argv;
  if (prog === "ssh") return { words: a, where: "ssh" };
  if (["docker", "podman", "kubectl"].includes(prog) && a.length > 1 && (a[0] === "exec" || a[0] === "run")) return { words: a.slice(1), where: "container" };
  return null;
}

/** A recursive `rm` anywhere among the words of a segment (`_has_recursive_rm`): behind a wrapper, after the target word. */
const wordsRemove = (words: string[]): boolean => words.some((w, i) => base(w) === "rm" && words.slice(i + 1).some((x) => RM_RECURSIVE.test(x)));

/** The find tail (`-exec`, `-execdir`, `-ok`, `-okdir` up to its terminator) is a recursive remover, run directly or through a runner's string. */
function findExecRemoves(argv: string[]): boolean {
  const exec = argv.findIndex((w) => EXEC_WORDS.has(w));
  if (exec < 0) return false;
  const tail = argv.slice(exec + 1);
  const end = tail.findIndex((w) => w === ";" || w === "+");
  const cmd = end >= 0 ? tail.slice(0, end) : tail;
  return (cmd.some((w) => base(w) === "rm") && cmd.some((w) => RM_RECURSIVE.test(w))) || (RUNNERS.has(base(cmd[0] ?? "")) && removerInString(cmd.join(" ")));
}

/** What a nested command does that the old check refused on another machine or in a container, else null; `rmOk` leaves a recursive rm out (ssh). */
function remoteKind(seg: ShellSegment, prog: string, env: FloorEnv, rmOk: boolean): string | null {
  const a = seg.argv;
  if (wordsRemove([seg.program, ...a]) || (prog === "find" && findExecRemoves(a)) || (seg.opaque === "nonliteral_script" && removerInString([seg.program, ...a].join(" ")))) return rmOk ? null : "a recursive rm";
  if (varCommandWord(seg.program) && a.some((w) => VAR_CMD_RECURSIVE.test(w))) return "a command word that is a variable with a recursive flag";
  if (prog === "shred") return "shred";
  if (prog === "find" && a.includes("-delete")) return "find -delete";
  if (pythonDisk(seg, prog)) return "a disk format or erase";
  if (unknownWriteTarget(seg, prog) !== undefined) return "a write, truncation or recursive permission change whose target is a variable";
  if (OWNERS.has(prog) && a.some((w) => /^-[A-Za-z]*R|^--recursive$/.test(w)) && a.filter((w) => !w.startsWith("-")).some((w) => systemRemoval(w, env))) return "a recursive permission change on a system path";
  const call = prog === "git" ? gitCall(seg, env) : null;
  if (call?.sub === "clean" && (gitCleanExclude(call) || a.some((w) => /[$`]/.test(w) || w === ""))) return "git clean with -e or a variable operand";
  return null;
}

/** Whether a word that holds whitespace, read as a command line, runs a recursive rm anywhere, in a word with spaces inside it too (`_has_recursive_rm` on the string). */
function spacedRemove(word: string, seg: ShellSegment, env: FloorEnv): boolean {
  return parseShell(word, { cwd: seg.cwd, platform: env.platform }).some((x) => wordsRemove([x.program, ...x.argv]) || [x.program, ...x.argv].some((w) => /\s/.test(w) && w !== word && spacedRemove(w, seg, env)));
}

/** A PowerShell or cmd delete or disk command among the units of `text`: the old check read them in a remote command too. */
function psRemoteKind(text: string): string | null {
  if (psUnknownDeletes(text, 0).some((h) => h.floor || h.ask)) return "a PowerShell command that cannot be read";
  const diskRe = RAW.find((r) => r.name === "disk")!;
  for (const words of psUnits(text)) {
    if (psRecursiveDelete(words)) return "a recursive PowerShell or cmd delete";
    const t = words.join(" ");
    if (diskRe.re.test(t) || /^format(?:\.exe|\.com)?\s+[a-z]:/i.test(t)) return "a disk format or erase";
  }
  return null;
}

const withFragment = (h: FloorHit, seg: ShellSegment): FloorHit => (h.fragment ? h : { ...h, fragment: cutFragment([seg.program, ...seg.argv].join(" ")) });

/** The words left of a segment when its program is a privilege program (`_strip_wrappers`: its own options, `-u user` included, taken off) or a multiplexer (`busybox rm`); null when it is neither. */
function behindWrapper(seg: ShellSegment): string[] | null {
  const prog = base(seg.program);
  if (PRIVILEGE.has(prog)) {
    let i = 0;
    while (i < seg.argv.length && seg.argv[i].startsWith("-")) i += /^-[ugpCUhrt]$/.test(seg.argv[i]) ? 2 : 1;
    return i < seg.argv.length ? seg.argv.slice(i) : null;
  }
  return /^(?:busybox|toybox)$/.test(prog) && seg.argv.length > 0 && !seg.argv[0].startsWith("-") ? seg.argv : null;
}

/** The words as one shell line: a word with a space or a metacharacter quoted, an expansion left as it is. */
const wordsText = (words: string[]): string => words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) || (/[$`]/.test(w) && !/\s/.test(w)) ? w : `'${w.replace(/'/g, "'\\''")}'`)).join(" ");

/**
 * The segments of a line and, below them, every segment the parser does not unwrap itself: the body of a function, select, coproc or arithmetic for, and the words behind
 * `busybox`/`toybox` or a privilege program (the paths `pythonKinds` re-parses). For the judge-first rules that read a segment's own program (inline code, a remote command).
 */
export function nestedSegments(segs: ShellSegment[], env: { cwd: string; platform: FloorEnv["platform"] }, depth = 0): ShellSegment[] {
  return nestedSegmentsSeen(segs, env, depth, new Set(), { n: 0 });
}

/**
 * Segments the walk emitted inside function bodies it walked at a call (`ShellSegment.walked`) that one line may have read below the top ones; past it such a segment's nested text is not read but the
 * segment is marked `programUnknown` (judge-first, never an allow). Everything the text of the line reads as without those copies (what origin/main read) is always read, with no budget.
 */
export const NESTED_SEGMENT_BUDGET = 1500;

function nestedSegmentsSeen(segs: ShellSegment[], env: { cwd: string; platform: FloorEnv["platform"] }, depth: number, seen: Set<string>, used: { n: number }): ShellSegment[] {
  const out: ShellSegment[] = [];
  for (const seg of segs) {
    out.push(seg);
    if (seg.walked) used.n++;
    if (depth >= NORMALISE_DEPTH) continue;
    const rest = behindWrapper(seg);
    const texts: string[] = rest ? [wordsText(rest)] : seg.opaque !== null && seg.opaque !== "parse_error" ? seg.bodies ?? [] : [];
    const mux = rest !== null && /^(?:busybox|toybox)$/.test(base(seg.program)) && seg.stdinFed !== false;
    for (const t of texts) {
      // a text read again with the same folder, names and depth gives the same segments (bodies defined inside bodies, walked at every call, repeat): read once
      const key = JSON.stringify([depth, seg.cwd ?? env.cwd, seg.harnessRebound ?? null, t]);
      if (!rest && seen.has(key)) continue;
      if (seg.walked && used.n > NESTED_SEGMENT_BUDGET) {
        out.push({ ...seg, programUnknown: true });
        break;
      }
      seen.add(key);
      const inner = nestedSegmentsSeen(parseShell(t, { cwd: seg.cwd ?? env.cwd, platform: env.platform, rebound: seg.harnessRebound, ...(rest ? {} : { noCalls: true }) }), env, depth + 1, seen, used);
      // `busybox sh <<'E'`: the applet reads the outer segment's heredoc or pipe as its program, so the inner shell inherits that marker
      if (mux && inner[0] && inner[0].opaque === null && (SHELLS.has(base(inner[0].program)) || base(inner[0].program) === "ash") && shellReadsStdin(inner[0].argv)) {
        inner[0] = carryFacts({ ...inner[0], opaque: "stdin_fed", heredoc: seg.heredoc, heredocs: seg.heredocs, ...(seg.dynamicCode ? { dynamicCode: true } : {}) }, inner[0]); // judge-first-unknown round: keeps programUnknown / harnessRebound
      }
      out.push(...inner);
    }
  }
  return out;
}

/** The old check's decisions on one local command that the gate reads from a segment, for the commands it does not parse itself (a function body, the words behind a wrapper). */
function localKind(seg: ShellSegment, prog: string, env: FloorEnv): FloorHit | null {
  const d = deleteFloor(seg, prog, env) ?? chmodFloor(seg, prog, env);
  // a recursive rm outside the roots is judge-first here (the old check asked on a literal one and refused one behind a wrapper; no floor read these nested forms before #289);
  // the home, root and system targets and shred stay denies
  if (d) return withFragment(d.rule === "floor-delete-outside" && prog === "rm" ? judgeHit("delete-unknown-target", `A recursive rm of a target outside the worktree, your scratch dir and /tmp, run through a function body, wrapper or string.`) : d, seg);
  if (pythonDisk(seg, prog)) return withFragment(hit("disk", `\`${prog}\` formats, erases or overwrites a disk. Ask the user.`), seg);
  const unreadable = unknownWriteTarget(seg, prog);
  if (unreadable !== undefined) return withFragment(unknownWriteHit(unreadable), seg);
  const call = prog === "git" ? gitCall(seg, env) : null;
  const clean = call?.sub === "clean" ? gitCleanExclude(call) : null;
  return clean ? withFragment(clean, seg) : null;
}

/** The script a shell (`-c`, cmd's `/c`, PowerShell's `-Command`) or `eval` reads as code, outer quotes taken off: the old check read these strings as lines of their own, a literal one or not. */
function scriptsOf(seg: ShellSegment, prog: string): string[] {
  const unquote = (w: string): string => w.replace(/^(["'])([\s\S]*)\1$/, "$2");
  if (prog === "eval") return seg.argv.length ? [unquote(seg.argv.join(" "))] : [];
  if (!(SHELLS.has(prog) || prog === "ash")) return [];
  const i = seg.argv.findIndex((w) => /^-[a-z]*c$/i.test(w) || /^\/[ck]$/i.test(w) || /^-command$/i.test(w));
  const rest = i < 0 ? [] : seg.argv.slice(i + 1);
  return rest.length ? [unquote(prog === "cmd" || prog === "pwsh" || prog === "powershell" ? rest.join(" ") : rest[0])] : [];
}

/** Under `xargs` the stdin text becomes arguments of the command: a shell with no `-c` never reads it as its program, one with `-c` takes the words as its script. */
const underXargs = (seg: ShellSegment): boolean => seg.wrappers.some((w) => base(w) === "xargs");

/** A shell that reads its program from stdin (no `-c` string, no script file; `-s` and the values of `-o`/`-O` read as the parser reads them) runs the here-document or here-string on it as code: the texts, else none. */
function heredocScripts(seg: ShellSegment, prog: string): string[] {
  if (!seg.heredocs?.length) return [];
  // the walker keeps `xargs bash -c …` as the wrappers xargs, bash and the script's words as the program
  if (underXargs(seg)) return seg.wrappers.some((w) => SHELLS.has(base(w)) || base(w) === "ash") || ((SHELLS.has(prog) || prog === "ash") && seg.argv.some((w) => /^-[a-z]*c[a-z]*$/i.test(w))) ? seg.heredocs : [];
  if (!(SHELLS.has(prog) || prog === "ash")) return [];
  if (scriptsOf(seg, prog).length > 0 || !shellReadsStdin(seg.argv)) return [];
  return seg.heredocs;
}

/** Whether an `ssh` call names a remote command after the host (the options that take a value are stepped over); without one the remote shell reads stdin as its program. */
function sshHasCommand(words: string[]): boolean {
  let operands = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") return words.length - i - 1 + operands > 1;
    if (w.length > 1 && w.startsWith("-")) {
      const at = Array.from(w.slice(1)).findIndex((ch) => SSH_ARG.has(ch));
      if (at >= 0 && at === w.length - 2) i++;
    } else operands++;
  }
  return operands > 1;
}

const tooDeepHit = (text: string): FloorHit => judgeHit("delete-unknown-target", `This command nests command substitutions, blocks or subshells deeper than the parser reads, so what it deletes cannot be read.`, text);

/** Hangs the stdin texts of `outer` on the segments parsed from what it unwrapped (the parser leaves the property off a clone). */
function withHeredocs(inner: ShellSegment[], outer: ShellSegment): void {
  if (!outer.heredocs?.length) return;
  for (const x of inner) {
    if (!x.heredocs?.length) Object.defineProperty(x, "heredocs", { value: outer.heredocs, enumerable: false, configurable: true });
    if (outer.dynamicCode) Object.defineProperty(x, "dynamicCode", { value: true, enumerable: false, configurable: true });
  }
}

/** How many unwrappings (privilege program, multiplexer, string, body, remote) the check follows before it refuses the line unread. */
const NORMALISE_DEPTH = 16;

/**
 * The Python-kind check set (PR B2, owner decisions of 2026-11-18 and 2026-11-19): what the old delete check refused, read from parsed segments and run
 * on every path that nests a command the parser does not unwrap itself: the body of a shell function, what stands behind a privilege program or `busybox`/`toybox` (taken off, parsed again and checked whole, to a fixpoint), and the command of
 * `ssh`, `docker`/`podman` `exec`/`run` and `kubectl exec` (every kind there, a recursive `rm` over ssh excepted). The marker of the outer segment (`function_def`,
 * the runner's `unsupported`) stays as it was; only the old check's decisions are added. A system delete, a disk format and a recursive permission change on a system path
 * are denies; everything else the old check refused is a judge-first hit, kept in `acc` so that a deny found later on the line still wins. `top` is the line itself: its own
 * segments were judged by `segmentFloors` already.
 */
function pythonKinds(text: string, segs: ShellSegment[], env: FloorEnv, where: Where, depth: number, top: boolean, acc: { hit: FloorHit | null; seen?: Set<string>; read?: number }): FloorHit | null {
  // a judge-first hit is kept, not returned: a deny later on the line still wins
  const settle = (h: FloorHit | null): FloorHit | null => {
    if (h?.kind !== "judge") return h;
    acc.hit = acc.hit ? absorb(acc.hit, h) : h;
    return null;
  };
  // an unreadable nesting this deep goes to the judge unread
  if (depth > NORMALISE_DEPTH) return settle(judgeHit("delete-unknown-target", "This command nests wrappers too deep to be read, so what it deletes cannot be read.", text));
  // every text parsed again (a string, a here-document, a body, the words behind a wrapper or a host) may hold a `$( )` the walker stopped at: unread, as at the top
  if (segs.some((s) => s.tooDeep)) settle(tooDeepHit(text));
  // the budget is for the copies of walked function bodies (`walked`) alone; the segments the line's text reads as are always read in full, as before the walk existed
  const spent = (seg: ShellSegment): boolean => {
    if (!seg.walked) return false;
    acc.read = (acc.read ?? 0) + 1;
    if (acc.read <= NESTED_SEGMENT_BUDGET) return false;
    settle(judgeHit("delete-unknown-target", "This command calls function bodies too many times or too deep to be read, so what it deletes cannot be read.", text));
    return true;
  };
  for (const seg of segs) {
    if (spent(seg)) continue;
    const prog = base(seg.program);
    // one normaliser for every entry point: a privilege program or multiplexer is taken off, the rest is parsed again and gets the whole check (strings, eval, bodies, xargs,
    // containers, ssh), to a fixpoint. A line's own `sudo` is the privilege floor's.
    const rest = top && PRIVILEGE.has(prog) ? null : behindWrapper(seg);
    if (rest) {
      const restText = wordsText(rest);
      // what the outer segment was unwrapped from (xargs, a string) and its marker stay on the inner ones
      const inner = parseShell(restText, { cwd: seg.cwd, platform: env.platform }).map((x) => carryFacts({ ...x, wrappers: [...seg.wrappers, ...x.wrappers], passThrough: [...(seg.passThrough ?? []), ...(x.passThrough ?? []).map((i) => i + seg.wrappers.length)], opaque: x.opaque ?? seg.opaque, redirectEnd: x.redirectEnd, ...(x.bodies ? { bodies: x.bodies } : {}), ...(x.tooDeep ? { tooDeep: true } : {}) }, x));
      // what feeds the unwrapped command's stdin (`busybox sh <<E`) stays with it
      withHeredocs(inner, seg);
      const h = pythonKinds(restText, inner, env, where, depth + 1, false, acc);
      if (h) return withFragment(h, seg);
      continue;
    }
    const remote = remoteCommand(seg, prog);
    if (remote && remote.words.length > 0) {
      const inWhere: Where = where === "container" || remote.where === "container" ? "container" : "ssh";
      const rtext = remote.words.join(" ");
      const inner = parseShell(rtext, { cwd: seg.cwd, platform: env.platform });
      withHeredocs(inner, seg);
      const texts: [string, ShellSegment[]][] = [[rtext, inner]];
      // the remote shell runs the command from its first spaced word on as one string (a compound: `if ...; then ...; fi`, `{ ...; }`); the host, the container and the options
      // before it do not belong to it, and the joined text above does not parse with them in front: read only then, each command of it as the plain path reads a command behind the host.
      let compound: ShellSegment[] | null = null;
      const at = inner.some((x) => x.opaque === "parse_error") ? remote.words.findIndex((w) => /\s/.test(w)) : -1;
      if (at >= 0) {
        const ctext = remote.words.slice(at).join(" ");
        if (ctext !== rtext) {
          // each command of the compound stands where the plain path has the host: a word after the program, so the same rules read it as read `ssh h 'cmd'`
          const cparsed = parseShell(ctext, { cwd: seg.cwd, platform: env.platform, rebound: seg.harnessRebound }).map((x) => carryFacts({ ...x, program: remote.words[0], argv: [x.program, ...x.argv], redirectEnd: x.redirectEnd, ...(x.bodies ? { bodies: x.bodies } : {}), ...(x.tooDeep ? { tooDeep: true } : {}) }, x));
          withHeredocs(cparsed, seg);
          texts.push([ctext, cparsed]);
          compound = cparsed;
        }
      }
      // a shell in the remote command reads the here-document of this segment as its program, and so does the login shell of an `ssh` that names no command
      if (seg.heredocs?.length && !underXargs(seg) && (remote.words.some((w) => SHELLS.has(base(w))) || (prog === "ssh" && !sshHasCommand(remote.words)))) for (const body of seg.heredocs) texts.push([body, parseShell(body, { cwd: seg.cwd, platform: env.platform })]);
      // the old check refused a recursive rm anywhere in the text first; over ssh that is the owner's exception, and the text is not read further
      if (texts.some(([, parsed]) => parsed.some((x) => wordsRemove([x.program, ...x.argv])))) {
        if (inWhere === "ssh") continue;
        settle(withFragment(remoteHit("a recursive rm", inWhere), seg));
        continue;
      }
      // a container takes its words as argv: a word that holds whitespace is a string some program may run (`zsh -c "sh -c 'rm -rf /'"`, `su -c ...`), whatever precedes it; it is parsed
      // and read the same way, in the words with spaces inside it too. Only a recursive rm found there is refused; every other kind in such a word is ignored
      if (remote.where === "container" && remote.words.some((w) => /\s/.test(w) && spacedRemove(w, seg, env))) {
        settle(withFragment(remoteHit("a recursive rm", inWhere), seg));
        continue;
      }
      for (const [t, parsed] of texts) {
        const h = pythonKinds(t, parsed, env, inWhere, depth + 1, false, acc);
        if (h) return withFragment(h, seg);
      }
      // the compound's own units, each behind the host as the plain path reads a command (the joined text would put the keywords at command position); a function body stands behind the host when the function is the first command, as in the body check below
      const ps = psRemoteKind(compound ? compound.flatMap((x, k) => [[x.program, ...x.argv].join(" "), ...(x.bodies ?? []).flatMap((b) => parseShell(b, { cwd: seg.cwd, platform: env.platform }).map((y, j) => [...(k === 0 && j === 0 ? [x.program] : []), y.program, ...y.argv].join(" ")))]).join("; ") : rtext);
      if (ps) settle(withFragment(remoteHit(ps, inWhere), seg));
    }
    if (where !== "local") {
      const kind = remoteKind(seg, prog, env, where === "ssh");
      if (kind) settle(withFragment(remoteHit(kind, where), seg));
      continue;
    }
    for (const script of [...scriptsOf(seg, prog), ...heredocScripts(seg, prog)]) {
      const h = pythonKinds(script, parseShell(script, { cwd: seg.cwd, platform: env.platform }), env, where, depth + 1, false, acc);
      if (h) return withFragment(h, seg);
    }
    if (!top) {
      const h = settle(localKind(seg, prog, env));
      if (h) return h;
    }
  }
  if (where === "local" && !top) settle(unknownFloor(text, segs, env));
  // every segment kind whose body the walker records (function, select, coproc, arithmetic for) gets the check: the class is what that function returns
  for (const opaque of segs) {
    if (opaque.opaque === null || opaque.opaque === "parse_error") continue;
    if (opaque.walked && (acc.read ?? 0) > NESTED_SEGMENT_BUDGET) continue;
    for (const body of opaque.bodies ?? []) {
      // the same body read again in the same place and state (a body defined inside a body is walked at every call and shows up once more each time) gives the same hits: read once
      const key = JSON.stringify([body, opaque.cwd ?? env.cwd, opaque.harnessRebound ?? null, opaque.bodyConsts ?? null, opaque.program, where, depth, where !== "local" && segs.indexOf(opaque) === 0]);
      if ((acc.seen ??= new Set()).has(key)) continue;
      acc.seen.add(key);
      const parsed = parseShell(body, { cwd: opaque.cwd ?? env.cwd, platform: env.platform, rebound: opaque.harnessRebound, noCalls: true, ...(env.child && env.scratch?.[0] ? { env: { ...(opaque.bodyConsts?.includes("FOREMAN_SCRATCH") ? { FOREMAN_SCRATCH: env.scratch[0] } : {}), ...(env.out && opaque.bodyConsts?.includes("FOREMAN_OUT") ? { FOREMAN_OUT: env.out } : {}) } } : {}) });
      // a body in a remote string reads as the same commands in `ssh h '...'`: the first command of the whole text stands behind the host (`ssh h 'f(){ find /data -delete; }; f'` runs as
      // `ssh h 'find /data -delete'` does), the later ones are read (`ssh h 'f(){ ls; shred /x; }; f'` as `ssh h 'ls; shred /x'`)
      const first = where !== "local" && segs.indexOf(opaque) === 0;
      const inner = parsed.map((x, k) => (first && k === 0 ? carryFacts({ ...x, program: opaque.program, argv: [x.program, ...x.argv], redirectEnd: x.redirectEnd, ...(x.bodies ? { bodies: x.bodies } : {}), ...(x.tooDeep ? { tooDeep: true } : {}) }, x) : x));
      // every body counts one level of depth, as on main: nesting past the cap is judge-first, whether the body runs at a call or not
      const h = pythonKinds(body, inner, env, where, depth + 1, false, acc);
      if (h) return h;
      // the old check read a PowerShell delete in a function body too (`f(){ Remove-Item -Recurse $x; }`): the units of the PowerShell-only removers
      const psText = inner.filter((x) => /^(?:remove-item|ri)$/i.test(base(x.program))).map((x) => [x.program, ...x.argv].join(" ")).join("\n");
      if (psText) {
        const d = psUnitFloors(psText, env);
        if (d) return d;
        const u = psUnknownDeletes(psText, 0).find((x) => x.floor);
        if (u) settle(judgeHit("delete-unknown-target", `The target of this recursive delete cannot be read (${u.reason}).`, psText));
        settle(psOutsideDelete(psText, env));
      }
    }
  }
  return null;
}

const remoteHit = (kind: string, where: Where): FloorHit => judgeHit("remote-command", `${kind} on another machine or in a container (${where === "ssh" ? "ssh" : "docker, podman or kubectl"}) cannot be checked from here.`);

/** `pythonKinds` for one line: a deny, else the first judge-first hit it kept. */
function nestedKinds(text: string, segs: ShellSegment[], env: FloorEnv, top: boolean): FloorHit | null {
  const acc: { hit: FloorHit | null } = { hit: null };
  return pythonKinds(text, segs, env, "local", 0, top, acc) ?? acc.hit;
}

// ------------------------------------------------------------------ raw text

const CMD = "(?:^|[;&|(\\n`]|\\$\\()\\s*(?:\\w+=\\S*\\s+)*";

// A2: `git` at a command position. CMD widened by the shell keywords that can stand before a command and by the wrapper programs; the options
// `-C <dir>`, `-c k=v`, `--git-dir`, `--work-tree` and friends may sit between `git` and its verb (captured).
const GIT_WRAPPERS = "env|nohup|xargs|timeout|nice|command|exec|time|sudo|doas|stdbuf|ionice|setsid";
const GIT_VERB = `(?:[\\w.~/-]*/)?git(?:[ \\t]+(?:-[Cc][ \\t]+\\S+|--(?:git-dir|work-tree|namespace|exec-path)(?:=\\S*|[ \\t]+\\S+)|-[pP]|--(?:no-pager|paginate|bare|no-replace-objects|literal-pathspecs|no-optional-locks)))*[ \\t]+([a-z][\\w-]*|\\$\\S*)`;
const CALL_PREFIX =
  `(?:^|[;&|(\\n\`{!]|\\$\\()[ \\t]*(?:\\w+=\\S*[ \\t]+)*(?:(?:do|then|else|elif|if|while|until|coproc|time)[ \\t]+|[!{(][ \\t]*)*` +
  `(?:(?:${GIT_WRAPPERS})(?:[ \\t]+(?:-{1,2}[\\w-]+(?:=\\S+)?|\\d+[smhd]?|\\w+=\\S*|\\{\\}))*[ \\t]+)*`;
const GIT_CALL = new RegExp(CALL_PREFIX + GIT_VERB, "g");
/** The command position is unknown (a runner or a program built by substitution reads the text as code): git anywhere. The verb is a word of its own, not a piece of a path or a name (`guard-false-blocks-2-push`, `src/push.ts`). */
const GIT_ANY = /(?<![\w./-])(push|remote)(?![\w./-])/g;
/** `cmd`: the entry is a command-position word match for a program the segment checks name too; a clean line skips it (`cleanLine`). */
const RAW: { name: string; re: RegExp; reason: string; cmd?: true }[] = [
  { name: "download-shell", re: /\b(?:curl|wget|fetch|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+\S+\s+)?(?:\/\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby|php|iex|invoke-expression|pwsh|powershell)\b/i, reason: "A download piped into a shell or interpreter runs unreviewed code. Download to your scratch dir, read the file, then run what you checked." },
  { name: "download-shell", re: /\b(?:sh|bash|zsh|dash|ksh|source|\.)\s+<\(\s*(?:curl|wget)\b/i, reason: "A download run through process substitution runs unreviewed code. Download to your scratch dir, read it, then run it." },
  { name: "download-shell", re: /\b(?:eval|iex|(?:ba|z|da|k)?sh\s+-c)\b[^\n;&|]*(?:\$\(|`)\s*(?:curl|wget|iwr|irm)\b/i, reason: "A downloaded script evaluated in the shell runs unreviewed code. Download to your scratch dir, read it, then run it." },
  { name: "privilege", re: new RegExp(`${CMD}(?:sudo|doas|su|pkexec)(?:\\s|$)`), reason: "Privilege escalation is not allowed. Run the command as the current user; ask the user when root is needed.", cmd: true },
  { name: "shutdown", re: new RegExp(`${CMD}(?:shutdown|reboot|halt|poweroff)(?:\\s|$)`), reason: "Shutting down or rebooting the machine is not allowed. Ask the user.", cmd: true },
  { name: "disk", re: new RegExp(`${CMD}(?:mkfs\\S*|fdisk|sfdisk|parted|wipefs|diskpart|format-volume|clear-disk|remove-partition)(?:\\s|$)`, "i"), reason: "Formatting or repartitioning a disk is not allowed. Ask the user.", cmd: true },
  { name: "disk", re: /\bdd\b[^\n;&|]*\bof=(?:\/dev\/|\\\\\.\\)/i, reason: "`dd` to a device overwrites a disk. Write to a file inside the worktree or /tmp instead." },
  { name: "git-config", re: /(?:^|[\s;&|(=])(?:GIT_CONFIG_(?:COUNT|KEY_[0-9]+|VALUE_[0-9]+|SYSTEM|PARAMETERS)\s*=|GIT_CONFIG_GLOBAL\s*=(?!(?:\/dev\/null|'\/dev\/null'|"\/dev\/null")(?:[\s;&|]|$)))/, reason: "Injecting git config through GIT_CONFIG_* variables can change hooks, remotes and credentials." },
  { name: "git-config", re: /--config-env\b/, reason: "`--config-env` injects git config." },
];

/** Floors that need the raw text only: specific enough to apply to every shell line (a download piped into a shell, privilege, power, disk, injected git config). */
export function rawFloors(text: string): FloorHit | null {
  return rawScan(text, false, blankComments(text));
}

/**
 * The raw scan; `skipCmd` leaves out the command-position entries of programs the segment checks judge (a clean line). `download` is the text the download-shell entries read:
 * the same text with its comments blanked (`downloadText`); every other entry reads `text`, comments included.
 */
function rawScan(text: string, skipCmd: boolean, download: string = text): FloorHit | null {
  let soft: FloorHit | null = null;
  for (const r of RAW) {
    if (skipCmd && r.cmd) continue;
    const m = r.re.exec(r.name === "download-shell" ? download : text);
    if (!m) continue;
    const fragment = m[0].replace(/^[\s;&|(`$]+/, "").trim();
    // injected git config is judge-first and waits behind every other raw floor
    if (r.name === "git-config") soft ??= judgeHit("git-config", r.reason, fragment);
    else return hit(r.name, r.reason, fragment);
  }
  return soft;
}

/** `scan` (the masked line) for the download-shell entries: built from `text` with its comments blanked first (the parser's node positions index the unmasked text). */
const downloadText = (text: string, segments: ShellSegment[]): string => maskLine(blankComments(text), segments);

/** The raw words of a line, split on whitespace, quotes and `=`, lower-cased (for the opaque-line key scan). */
const rawWords = (text: string): string[] => text.toLowerCase().split(/[\s'"`=;&|()<>]+/).filter(Boolean);

/**
 * Floors on the raw text of a line the walker could not state exactly (opaque segment or parse error). A word match on a git push, a git config
 * key, a remote change, a force push or a protected branch is an ASK (r79 item 4, Addendum S1): the text may be quoted prose, so it is the owner's
 * call, never a deny and never the classifier's. A package publish or a removal of the root stays a deny. Obfuscation reaches the owner or a deny,
 * never a default allow and never the mode step.
 */
export function opaqueTextFloors(text: string, env: FloorEnv): FloorHit | null {
  return opaqueTextFloorsAt(text, env, false);
}

function opaqueTextFloorsAt(text: string, env: FloorEnv, anywhere: boolean): FloorHit | null {
  const lower = text.toLowerCase();
  let soft: FloorHit | null = null;
  // A2: git counts only at a command position (after `;` `&` `|` `(` a newline, a shell keyword or a wrapper program); the verb is the word after git's own options
  const calls = (anywhere && !/\bgit\b/.test(lower) ? [] : [...lower.matchAll(anywhere ? GIT_ANY : GIT_CALL)]).map((m) => {
    const end = (m.index ?? 0) + m[0].length;
    return { verb: m[1], tail: lower.slice(end).split(/[\n;&|]/)[0], tailText: text.slice(end).split(/[\n;&|]/)[0] };
  });
  // a verb that is a variable (`git ${V:-push} origin main`) may be a push: it gets the force and protected-branch checks below (not the child's push deny)
  const dynamic = calls.find((c) => c.verb.startsWith("$"));
  if (calls.length > 0 || (anywhere && /\bgit\b/.test(lower))) {
    const push = calls.find((c) => c.verb === "push") ?? dynamic;
    // A3: a child cannot answer an owner question about a line the parser could not read: a deterministic deny that says how to rephrase
    const flag = env.child ? opaqueDeny : askHit;
    if (env.child && !env.builder && push && push !== dynamic) return flag("git-push-child", `The unparsed line looks like a git push. ${PUSH_CHILD_TEXT}`);
    // git config words are judge-first (a child's judge-first hit asks its parent): they wait behind the push floors and the denies below
    const key = rawWords(text).find((w) => floorKey(w) && w.includes("."));
    if (key !== undefined) soft = judgeHit("git-config", `The unparsed line names the git config key '${key}', which changes where code is fetched or pushed, which program git runs or which credentials it uses.`, key);
    else if (calls.some((c) => c.verb === "remote" && /^\s+(?:add|set-url|rename|remove|rm|set-head|set-branches)\b/.test(c.tail))) soft = judgeHit("git-config", "The unparsed line changes a git remote.");
    if (push && /(?:\s--(?:force|force-with-lease|force-if-includes|mirror|delete|prune|all)\b|\s-[a-z]*[fd][a-z]*\b|\s\+\S|\s:\S)/.test(push.tail)) return flag("git-push-force", "The unparsed line looks like a force, delete, mirror or colon-refspec push.");
    // every entry: the literal whole-word search; an entry with a wildcard is also matched against each token of the push tail
    const tokens = push ? (push.tailText.match(/[A-Za-z0-9._/*-]+/g) ?? []).map((t) => t.replace(/^refs\/heads\//, "")) : [];
    const prot = push ? [...protectedSet(env)].find((b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(push.tailText) || (/[*?[]/.test(b) && tokens.some((t) => protectedMatch([b], t, { ignoreCase: true }) !== undefined))) : undefined;
    if (prot !== undefined) return flag("git-push-protected", `The unparsed line pushes '${prot}', a default or protected branch.`);
  }
  // the package program stands at a command position (anywhere: a runner reads the text as code) and the verb follows within the same statement
  const pubWords = "(?:npm|pnpm|yarn|bun|cargo|twine|gem|poetry)[ \\t]+[^\\n;&|]*?\\b(?:publish|upload|push)\\b";
  const pub = new RegExp(anywhere ? `\\b${pubWords}` : `${CALL_PREFIX}${pubWords}`).exec(lower);
  if (pub) return hit("publish", "The unparsed line publishes a package. Ask the user to publish.", text.slice(pub.index, pub.index + pub[0].length).replace(/^[\s;&|(`$]+/, ""));
  const rmRoot = new RegExp(`${CMD}rm\\s+(?:-\\S+\\s+)*(?:--\\s+)?(?:/|~|\\$HOME|\\$\\{HOME\\})/?\\*?(?:\\s|$)`).exec(text);
  if (rmRoot) return hit("rm-system", "Removing the file system root or the home directory is never allowed.", rmRoot[0].replace(/^[\s;&|(`$]+/, "").trim());
  return soft;
}

/**
 * `text` with the content of its quoted strings blanked: single quotes and `$'..'` always (nothing expands there), double quotes unless the
 * string holds a `$(` or backtick (those run; `${NAME}` only expands to text). Runs on every line without a runner, where a quoted argument is text for the program,
 * not a command line.
 */
export function maskQuoted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      out += c + (text[i + 1] ?? "");
      i++;
    } else if (c === "'" || (c === "$" && text[i + 1] === "'")) {
      const open = c === "$" ? i + 1 : i;
      const end = text.indexOf("'", open + 1);
      if (end < 0) return out + text.slice(i);
      out += "''";
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return out + text.slice(i);
      const inner = text.slice(i + 1, j);
      out += /\$\(|`/.test(inner) ? text.slice(i, j + 1) : '""';
      i = j;
    } else out += c;
  }
  return out;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "pwsh", "powershell", "cmd"]);
const INTERP_E = new Set(["node", "nodejs", "python", "python2", "python3", "perl", "ruby", "php", "pwsh", "powershell", "deno", "bun", "lua", "rscript"]);
const EXTRA_RUNNERS = new Set(["eval", "source", ".", "xargs", "ssh", "awk", "gawk", "mawk", "nawk", "osascript"]);

/** Whether a segment runs text as a command: a runner program or wrapper, an interpreter given code, `-exec`, awk, ssh, osascript, deno eval|run (A1). Read from the parsed segments, never from raw words. */
function runsText(s: ShellSegment): boolean {
  const names = [base(s.program), ...s.wrappers.map(base)];
  if (names.some((n) => RUNNERS.has(n) || EXTRA_RUNNERS.has(n) || SHELLS.has(n))) return true;
  const p = names[0];
  if (p === "deno" && s.argv.some((a) => a === "eval" || a === "run")) return true;
  if (INTERP_E.has(p) && s.argv.some((a) => /^-[A-Za-z]*[ec]/.test(a) || a === "--eval" || a === "--command")) return true;
  return s.argv.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
}

/**
 * Whether a segment hands text to a shell: `runsText` without the interpreters' inline code (`python3 -c`, `node -e` run that code in the interpreter, not in a shell) and
 * without the pass-through wrappers the walker unwrapped (`env`, `nohup`, `timeout`...: the wrapped command is its own segment). A failed unwrap keeps the wrapper as the program.
 */
function runsShellText(s: ShellSegment): boolean {
  const names = [base(s.program), ...s.wrappers.filter((_, i) => !s.passThrough?.includes(i)).map(base)];
  if (names.some((n) => RUNNERS.has(n) || EXTRA_RUNNERS.has(n) || SHELLS.has(n))) return true;
  return s.argv.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
}

/** `text` with the bodies of heredocs blanked (the delimiter lines stay). */
function maskHeredocs(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([\w.-]+))/.exec(lines[i]);
    if (!m) continue;
    const tag = m[2] ?? m[3] ?? m[4];
    let j = i + 1;
    while (j < lines.length && (m[1] === "-" ? lines[j].replace(/^\t+/, "") : lines[j]).replace(/\r$/, "") !== tag) j++;
    if (j >= lines.length) continue;
    out.push("");
    out.push(lines[j]);
    i = j;
  }
  return out.join("\n");
}

/** A segment that may read its stdin as shell code: it hands text to a shell, or a shell is among its words (`docker exec -i c sh`). */
const shellConsumer = (s: ShellSegment): boolean => runsShellText(s) || s.argv.some((a) => SHELLS.has(base(a)) || base(a) === "ash");

/**
 * The line has a here-document or here-string and each body is data: `cat`, `tee`, a bare redirect, or an interpreter the walker reads as stdin-fed (`python3 -`, `node -`:
 * its code is not shell text). A body fed to a shell, a runner, a program with a shell among its words or a program the walker does not know (`at now <<EOF`) stays visible,
 * and so does every body of a line where a pipe feeds such a consumer. `maskLine` blanks the bodies.
 */
export function dataBodies(segments: ShellSegment[]): boolean {
  const bodies = segments.filter((s) => s.heredoc);
  const data = bodies.every((s) => (s.program === "" || ["cat", "tee"].includes(base(s.program)) || s.opaque === "stdin_fed") && !shellConsumer(s));
  return bodies.length > 0 && data && !segments.some((s) => s.stdinFed && shellConsumer(s));
}

/**
 * A heredoc body is data for the settings-file rule only when every segment that reads it through a pipe is `cat` or `tee`, no interpreter or variable program sits inside a
 * substitution (`tee >(python3) <<E`: the walker labels a process substitution like `$(`), and no heredoc command is an interpreter or a variable program.
 * A cleanly read segment (`grep`, `head`) fed by a pipe only reads the text, so it is no consumer that runs it.
 */
function bodiesOnlyCatTee(segments: ShellSegment[], env: FloorEnv): boolean {
  const plain = (s: ShellSegment): boolean => ["cat", "tee"].includes(base(s.program));
  const code = (s: ShellSegment): boolean => SHELL_LIKE.has(base(s.program)) || (s.opaque !== null && s.opaque !== "writing_wrapper");
  return segments.every((s) => (!s.heredoc || (s.program === "" ? s.opaque === null : plain(s))) && (!s.stdinFed || s.heredoc || plain(s) || cleanReadSegment(s, env)) && !(s.wrappers.includes("$(") && !plain(s) && code(s)));
}

/**
 * The text the raw and opaque-text floors scan (A1): quoted strings and the bodies of `cat`/`tee`/redirect-only heredocs are blanked.
 * A `cat`/`tee` data heredoc body is masked even when a later segment runs the written file (that segment is judged by the runner rules);
 * a body fed to a shell or interpreter stays visible. Quoted strings stay visible when a segment runs text.
 */
export function maskLine(text: string, segments: ShellSegment[]): string {
  const t = dataBodies(segments) ? maskHeredocs(text) : text;
  return segments.some(runsShellText) ? t : maskQuoted(t);
}

const LOOP_WORDS = new Set(["for", "while", "until", "if", "select", "case"]);
const NULL_TARGET = /^(\/dev\/null|nul)$/i;

/**
 * A3: the line only reads. Every segment's program (wrapper-stripped) is in the effects read class (or a loop keyword), no inline code, no runner,
 * no find action, no output redirect but an fd dup or the null device. Opacity does not count against it: the loop `for f in a b; do grep x $f; done` is opaque and still reads.
 */
export function readLooking(segments: ShellSegment[]): boolean {
  return segments.length > 0 && segments.every((s) => {
    const p = base(s.program);
    if (runsText(s)) return false;
    if (!LOOP_WORDS.has(p) && !READ_CLASS.has(p) && !/^(echo|printf|true|false|cd|pwd|test|\[)$/.test(p)) return false;
    if (p === "find" && s.argv.some((a) => FIND_BAD.has(a))) return false;
    if (s.heredoc && s.opaque !== null) return false;
    return s.redirects.every((r) => r.op === "<" || r.op === "dup" || NULL_TARGET.test(r.target));
  });
}

/** A deterministic deny for a text-only hit on a line the parser could not read: the child cannot answer an owner dialog (A3). */
const opaqueDeny = (name: string, reason: string, fragment?: string): FloorHit => hit(name, `${reason} Rephrase without a variable or loop, or let the foreman do it.`, fragment);

/**
 * The line is clean: the parse succeeded, no segment is opaque and no segment feeds text to an interpreter (a runner, a shell or interpreter given code,
 * `-exec`) and no here-document or here-string body is left visible by `maskLine` (any program but `cat`/`tee` may run it as code). The restart,
 * privilege and disk floors judge a clean line by the program of each segment only; every other line keeps their word match (G8, one rule).
 */
export function cleanLine(segments: ShellSegment[]): boolean {
  return segments.length > 0 && segments.every((s) => s.opaque === null && !runsText(s)) && (!segments.some((s) => s.heredoc) || dataBodies(segments));
}

/**
 * A line that does not parse is one `parse_error` segment, but a shell runs the statements before the error. The text before the statement that holds the parser's first
 * error (by its own offsets) is parsed once more and, when it parses, gets the restored checks; the parse error itself stays opaque for the rest, so the result is the
 * stricter of the two. A text whose cut still fails to parse is not read further.
 */
function completeLines(text: string, segments: ShellSegment[], env: FloorEnv): FloorHit | null {
  if (segments.length !== 1 || segments[0].opaque !== "parse_error") return null;
  const prefix = beforeParseError(text);
  if (prefix === null) return null;
  const parsed = parseShell(prefix, { cwd: segments[0].cwd, platform: env.platform });
  if (parsed.length === 0 || parsed.some((x) => x.opaque === "parse_error")) return null;
  return nestedKinds(prefix, parsed, env, false);
}

/**
 * The floors of a parsed shell line (r79): raw-text floors (quoted strings of a data-program line are blanked first: pinned steward cases 1 and 2),
 * every segment (a deny), then the opaque-line scan, whose hits are asks. A deny of any kind wins over an ask.
 */
export function lineFloors(text: string, segments: ShellSegment[], env: FloorEnv): FloorHit | null {
  const scan = maskLine(text, segments);
  const raw = rawScan(scan, cleanLine(segments), downloadText(text, segments));
  if (raw?.kind === "deny") return raw;
  // an ask or a judge-first hit waits behind every deny of the line; `$( )` nested past the walker's depth cap was never read, so the line goes to the judge
  let pending: FloorHit | null = segments.some((s) => s.tooDeep) ? strongerHit(raw, tooDeepHit(text)) : raw;
  if (segments.some((s) => s.opaque !== null)) {
    const anywhere = segments.some((s) => runsShellText(s) || /^[$`]/.test(s.program));
    const t = opaqueTextFloorsAt(scan, env, anywhere);
    // a judge-first hit of the text scan does not hide the protected-folder floors
    const prot = t && t.kind !== "judge" ? null : readLooking(segments) ? null : opaqueProtected(text, env, env.child === true, segments);
    const o = prot?.kind === "deny" ? prot : strongerHit(t, prot);
    if (o?.kind === "deny") return o;
    pending = strongerHit(pending, o);
  }
  // the powershell tool is one opaque segment (gate.ts powershellSegment): its command line is matched whole
  if (segments.length === 1 && segments[0].program === "powershell" && segments[0].argv.length === 0 && segments[0].opaque === "foreign_shell") {
    const bd = psBuiltinDeny(text, env);
    if (bd) return bd;
  }
  // O4: the PowerShell units of the powershell tool and of a bash line with a pwsh or cmd segment
  if (foreignSegments(segments)) {
    const pf = psUnitFloors(text, env);
    if (pf) return pf;
  }
  for (const s of segments) {
    const h = segmentFloors(s, env, segments);
    if (h?.kind === "deny") return h;
    pending = strongerHit(pending, h);
  }
  // PR B2: the old check's decisions on the paths that nest a command (function bodies, busybox and toybox applets, ssh and containers)
  // the powershell tool's line is one opaque segment: the old check read its text as a shell line too
  const psTool = segments.length === 1 && segments[0].program === "powershell" && segments[0].argv.length === 0 && segments[0].opaque === "foreign_shell";
  const n1 = nestedKinds(text, psTool ? parseShell(text, { cwd: segments[0].cwd, platform: env.platform }) : segments, env, !psTool);
  const n2 = psTool ? null : completeLines(text, segments, env);
  const nested = n1?.kind === "deny" ? n1 : n2?.kind === "deny" ? n2 : absorb(n1 ?? n2, n1, n2);
  if (nested?.kind === "deny") return nested;
  // a recursive delete the gate cannot read goes to the judge, by the predicate of the label
  const unknown = unknownFloor(text, segments, env);
  const last = pending ?? nested ?? unknown ?? (foreignSegments(segments) ? psOutsideDelete(text, env) : null);
  return absorb(last, pending, nested, unknown);
}

/**
 * The text floors of one command line read from a payload field (gate.ts leafFloors), no path or policy floor: the raw-text rules and the opaque-text rules (a push, a git
 * config key, a remote change, a package publish, the removal of the root). The whole line is scanned as a shell line is (`lineFloors`), and then each parsed segment
 * (the inner commands of `bash -c`, `eval` and backticks included) by its own words, so a floor anchored at a command position meets a program and never a word of
 * prose or an argument (a quoted word is data). A quoted program word is the program (`'sudo' ls`), and is no assignment when it holds an `=`.
 */
export function fieldLineFloors(line: string, segments: ShellSegment[], env: FloorEnv): FloorHit | null {
  const scan = maskLine(line, segments);
  const whole = rawScan(scan, cleanLine(segments), downloadText(line, segments));
  if (whole?.kind === "deny") return whole;
  // a field line is read as a shell line is: the PowerShell units of a `pwsh` or `cmd` segment (O4)
  const ps = foreignSegments(segments) ? psUnitFloors(line, env) : null;
  if (ps) return ps;
  let ask: FloorHit | null = whole;
  if (segments.some((s) => s.opaque !== null)) {
    const o = opaqueTextFloorsAt(scan, env, segments.some((s) => runsShellText(s) || /^[$`]/.test(s.program)));
    if (o?.kind === "deny") return o;
    ask = strongerHit(ask, o);
  }
  // a function body is only defined here, so its quoted text is not parsed: each quote-delimited piece of it is scanned
  if (segments.some((s) => s.opaque === "function_def")) {
    for (const piece of line.split(/[\n'"`]/).map((p) => p.trim()).filter(Boolean)) {
      const h = rawScan(piece, false) ?? opaqueTextFloors(piece, env);
      if (h?.kind === "deny") return h;
      ask = strongerHit(ask, h);
    }
  }
  for (const s of segments) {
    // a download piped into a shell or interpreter, read from the segments (the program of the download may be a quoted word)
    if (downloadFeedsShell(s, segments)) {
      const dl = RAW.find((r) => r.name === "download-shell");
      if (dl) return hit(dl.name, dl.reason);
    }
    const prog = /^\$'([^']*)'$/.exec(s.program)?.[1] ?? (/[=\s]/.test(s.program) ? "''" : s.program);
    const text = [prog, ...s.argv.map((w) => (/[\s;&|()<>`]/.test(w) ? "''" : w))].join(" ");
    let h = rawScan(text, false) ?? opaqueTextFloors(text, env);
    // the unanchored publish word counts only as the segment's program
    if (h?.rule === "floor-publish" && !text.toLowerCase().startsWith((h.fragment ?? "").toLowerCase().split(/\s/)[0])) h = null;
    if (h?.kind === "deny") return h;
    ask = strongerHit(ask, h);
  }
  return ask;
}

/** The input keys a path tool call is floored on (the path keys are also what the gate reads for the public-key rule id). */
export const PATH_KEYS = ["path", "file_path", "filePath"];
export const PATH_TOOL_KEYS = [...PATH_KEYS, "src", "dst", "glob", "pattern"];

/** The path tools that only read: an SSH public key in ~/.ssh is no secret for them (sshPublicKey). One set for the floors and the gate. */
export const READ_PATH_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** The floors of a path tool call (read, write, edit, grep, find, ls, foreman_move, foreman_copy): a secret or key path. */
export function pathFloors(input: Record<string, unknown>, env: FloorEnv, tool?: string, readField?: string | null, read = false): FloorHit | null {
  // a configured read tool (gate.readTools): its path field and `glob` only; `pattern`/`patterns` are search patterns
  const keys = readField !== undefined ? (readField === null ? ["glob"] : [readField, "glob"]) : PATH_TOOL_KEYS;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v) {
      const h = secretPath(v, env, read);
      if (h) return h;
    }
  }
  return tool !== undefined && WRITE_TOOLS.has(tool) ? protectedToolWrite(tool, input, env) : null;
}

// ------------------------------------------------------------------ policy files, harness state, config keys (writes)

const WRITE_TOOLS = new Set(["write", "edit", "foreman_move", "foreman_copy"]);
/** A foreman config file by name (`foreman.json`, `foreman.defaults.json`, `foreman.local.json`). */
const CONFIG_FILE = /(?:^|[\\/])foreman(?:[.-][\w.-]*)?\.json$/;
/** The config keys no agent write may touch: safety.permissions*, safety.policy*, gate.* (read from the written text, fail closed). */
const FLOOR_KEYS = /\b(?:permissions|policy[A-Za-z]*|gate)\b/;
/** The key forms of an unread line: dotted (`safety.permissions`, `gate.mode`) or quoted (`"permissions"`); a bare word in a path (`cleanup-permissions-2`) is no key. */
const UNREAD_KEYS = /\bsafety\.(?:permissions|policy[A-Za-z]*)|\bgate\.|["'](?:permissions|policy[A-Za-z]*|gate)["']/;

/**
 * A settings schema (`*.schema.json`) the session may edit: it lies inside the floor checks' `writeRoots` (the worktree, the temp dirs) and not under the package root
 * (the installed schema `foreman_config.py` validates against, also when the session runs in the package checkout). Whole path segments, real paths too.
 * A schema holds the words `gate` and `permissions` in its descriptions, which is no config key written.
 */
function editableSchema(abs: string, env: FloorEnv): boolean {
  if (!/\.schema\.json$/i.test(abs)) return false;
  const plat = env.platform ?? process.platform;
  const real = realDeep(abs);
  const roots = (env.writeRoots ?? []).flatMap((r) => [r, realDeep(r)].filter((x): x is string => !!x));
  const pkg = env.pkgRoot ?? DEFAULT_PKG_ROOT;
  const pkgs = [pkg, realDeep(pkg)].filter((x): x is string => !!x);
  return [abs, ...(real ? [real] : [])].every((c) => roots.some((r) => insideRoot(c, r, plat)) && !pkgs.some((k) => insideRoot(c, k, plat)));
}

const foldFor = (env: FloorEnv): boolean => (env.platform ?? process.platform) === "win32" || (env.platform ?? process.platform) === "darwin";

/** realpath of the deepest existing ancestor with the missing tail re-appended. */
export function realDeep(abs: string): string | null {
  const tail: string[] = [];
  let cur = abs;
  for (let n = 0; n < 64; n++) {
    // win32: the native realpath expands 8.3 short names (RUNNER~1), so a floored path in short form still meets its long-form floor
    const real = memoLookup<string | null>(`d:${cur}`, () => {
      try {
        return process.platform === "win32" ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      } catch {
        return null;
      }
    });
    if (real !== null) return tail.length ? path.join(real, ...tail.reverse()) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.push(path.basename(cur));
    cur = parent;
  }
  return null;
}

const envIds = new WeakMap<object, number>();
let envSerial = 0;

/** The comparable spellings of an absolute path: lexical and symlink-resolved, slashes unified, case-folded where the file system is. Remembered per path and environment while a gate call's look-up scope is open (a line that repeats its words asks again and again). */
function formsOf(abs: string, env: FloorEnv): string[] {
  let id = envIds.get(env);
  if (id === undefined) envIds.set(env, (id = ++envSerial));
  return memoLookup(`f:${id}:${abs}`, () => formsUncached(abs, env));
}

function formsUncached(abs: string, env: FloorEnv): string[] {
  const fold = foldFor(env);
  const real = realDeep(abs);
  const plat = env.platform ?? process.platform;
  // the shared normaliser: lexical and long-name form (8.3, case, separators, drive, symlinks) from the injected resolver
  const norm = [normPath(plat, abs, env.cwd, () => null), normPath(plat, abs, env.cwd, env.resolver)];
  return [...new Set([abs, ...(real ? [real] : []), ...norm].map((p) => {
    const s = slash(p).replace(/(.)\/$/, "$1");
    return fold ? s.toLowerCase() : s;
  }))];
}

/** The agent dirs: the session's and the default `<home>/.pi/agent`. */
const agentDirs = (env: FloorEnv): string[] => [env.agentDir, env.home ? path.join(env.home, ".pi", "agent") : undefined].filter((x): x is string => !!x);
const authFiles = (env: FloorEnv): string[] => agentDirs(env).map((a) => path.join(a, "auth.json"));

interface Protected {
  p: string;
  /** Covers everything below `p` too. */
  tree: boolean;
  /** Only files with this suffix below `p` (`flat`: directly in `p`). */
  ext?: string;
  flat?: boolean;
}

/** Whether the spelling `f` is covered by the entry spelled `g`. */
function covers(e: Protected, g: string, f: string): boolean {
  if (e.ext !== undefined) return f.endsWith(e.ext) && (e.flat ? path.posix.dirname(f) === g : f.startsWith(`${g}/`));
  return f === g || (e.tree && f.startsWith(`${g}/`));
}

/** Policy files of every layer and the harness state files. */
function protectedEntries(env: FloorEnv): Protected[] {
  const out: Protected[] = [];
  // r79 item 4: policy.md and permissions.policy.md are no longer read, so no longer protected; the three permissions.json files are
  for (const a of agentDirs(env)) {
    const s = path.join(a, "pi-foreman");
    for (const f of ["permissions.json", "managed.json", "state/round-parents.json", "state/bridge-trust.json"]) out.push({ p: path.join(s, f), tree: false });
    for (const d of ["state/approvals", "state/gate", "state/child-asks", "state/review-records", "state/panes"]) out.push({ p: path.join(s, d), tree: true });
    out.push({ p: path.join(a, "sessions"), tree: true, ext: ".jsonl" });
  }
  if (env.sessionDir) out.push({ p: env.sessionDir, tree: false, ext: ".jsonl", flat: true });
  for (const d of [".workflow", ".pi"]) out.push({ p: path.join(env.cwd, d, "permissions.json"), tree: false });
  return out;
}

/** A `permissions.json` directly below a `.workflow` or `.pi` dir, wherever that is (the main checkout's file is reached from a worktree too). */
const PERMS_BASENAME = /(?:^|\/)\.(?:workflow|pi)\/permissions\.json$/i;

/** The protected entry a word names (a glob word is matched against the entries), or null. */
function protectedWord(word: string, cwd: string, env: FloorEnv, entries: Protected[]): string | null {
  for (const v of braceVariants(word)) {
    const found = protectedOne(v, cwd, env, entries);
    if (found !== null) return found;
  }
  return null;
}

/** Whether any of `words` names a policy or state file or folder of the harness (the check the write floors use; no write is implied). */
export function harnessFolderWord(words: string[], cwd: string, env: FloorEnv): boolean {
  const entries = protectedEntries(env);
  return words.some((w) => protectedWord(w, cwd, env, entries) !== null);
}

/** The absolute spellings of the words that name the harness folder `<agent dir>/pi-foreman` itself or a path below it (the policy and state files too). */
export function harnessFolderPaths(words: string[], cwd: string, env: FloorEnv): string[] {
  const entries = agentDirs(env).map((a) => ({ p: path.join(a, "pi-foreman"), tree: true }));
  return words.flatMap((w) => braceVariants(w).flatMap((v) => protectedAt(v, cwd, env, entries)?.abs ?? []));
}

export const BRACE_LIMIT = 64;

/** `word` with its first top-level `{a,b}` group expanded (not `${..}`), recursively, at most BRACE_LIMIT variants; the word itself when it has none. */
export function braceVariants(word: string): string[] {
  const out: string[] = [];
  const walk = (w: string): void => {
    if (out.length >= BRACE_LIMIT) return;
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== "{" || w[i - 1] === "$" || w[i - 1] === "\\") continue;
      let depth = 0;
      const cuts: number[] = [];
      let end = -1;
      for (let j = i; j < w.length; j++) {
        if (w[j] === "{") depth++;
        else if (w[j] === "}" && --depth === 0) {
          end = j;
          break;
        } else if (w[j] === "," && depth === 1) cuts.push(j);
      }
      if (end < 0 || cuts.length === 0) continue;
      const bounds = [i, ...cuts, end];
      for (let k = 0; k < bounds.length - 1; k++) walk(w.slice(0, i) + w.slice(bounds[k] + 1, bounds[k + 1]) + w.slice(end + 1));
      return;
    }
    out.push(w);
  };
  walk(word);
  return out.length ? out : [word];
}

const protectedOne = (word: string, cwd: string, env: FloorEnv, entries: Protected[]): string | null => protectedAt(word, cwd, env, entries)?.p ?? null;

/** The entry a word names and the absolute spelling the word resolved to, or null. */
function protectedAt(word: string, cwd: string, env: FloorEnv, entries: Protected[]): { p: string; abs: string } | null {
  const w = slash(word.replace(/^(['"])(.*)\1$/, "$2"));
  const m = /^-{1,2}[\w-]+=(.+)$/.exec(w) ?? /^[A-Za-z_]\w*=(.+)$/.exec(w);
  for (const x of m ? [w, m[1]] : [w]) {
    if (!x || /\s/.test(x) || /[|()]/.test(x)) continue;
    let v = x;
    if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(v)) {
      if (!env.home) continue;
      v = path.posix.join(slash(env.home), v.replace(/^(~|\$HOME|\$\{HOME\})/, ""));
    }
    const cut = v.search(/[$`]/);
    if (cut >= 0) v = v.slice(0, cut);
    if (!v) continue;
    const abs = path.posix.isAbsolute(v) || path.win32.isAbsolute(v) ? v : slash(path.resolve(cwd, v));
    if (/[*?[]/.test(abs)) {
      const fold = foldFor(env);
      const lit = abs.slice(0, abs.search(/[*?[]/));
      const dir = formsOf(lit.endsWith("/") ? lit.slice(0, -1) : path.posix.dirname(lit), env);
      const found = entries.find((e) => formsOf(e.p, env).some((g) => (e.ext !== undefined ? (abs.endsWith(e.ext) || /[*?\]]$/.test(abs)) && dir.some((f) => (e.flat ? f === g : f === g || f.startsWith(`${g}/`))) : globMatch(abs, g, fold) || (e.tree && dir.some((f) => f === g || f.startsWith(`${g}/`))))));
      if (found) return { p: found.p, abs };
      continue;
    }
    const mine = formsOf(abs, env);
    const found = entries.find((e) => formsOf(e.p, env).some((g) => mine.some((f) => covers(e, g, f))));
    if (found) return { p: found.p, abs };
    if (mine.some((f) => PERMS_BASENAME.test(f))) return { p: abs, abs };
  }
  return null;
}

const protHit = (what: string, word: string): FloorHit => hit("policy-file", `${what} '${word.slice(0, 120)}', a permissions file (permissions.json of the user, the project's .workflow or the tracked .pi), a harness state file (managed.json, state/round-parents.json, state/bridge-trust.json, state/approvals, state/gate, state/child-asks, state/review-records) or a Pi session file (*.jsonl under the sessions dir). Ask the user to change it.`, word);
const configHit = (what: string, word: string): FloorHit => hit("config-keys", `${what} the safety.permissions*, safety.policy* or gate.* keys of the foreman config file '${word.slice(0, 120)}'. The agent never changes these keys. Ask the user to change them.`, word);

export { READ_PROGS };
const GIT_NONWRITE = new Set(["diff", "log", "show", "status", "blame", "ls-files", "grep", "cat-file", "rev-parse", "check-ignore", "add", "commit", "rev-list", "describe", "shortlog"]);

/** Whether the segment only reads (or stages) its path operands. */
function readOnlySegment(seg: ShellSegment, prog: string): boolean {
  const a = seg.argv;
  if (READ_PROGS.has(prog)) return true;
  if (prog === "sed") return !a.some((w) => /^-[A-Za-z]*i|^--in-place/.test(w));
  if (prog === "find") return !a.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
  if (prog === "git") {
    const sub = a.find((w, i) => !w.startsWith("-") && (i === 0 || !/^(-C|-c|--git-dir|--work-tree)$/.test(a[i - 1])));
    return sub !== undefined && GIT_NONWRITE.has(sub);
  }
  return false;
}

/** The source operands of a copy (every positional but the destination): read only. */
function copySourceWords(seg: ShellSegment, prog: string): Set<string> {
  const out = new Set<string>();
  if (prog !== "cp" && prog !== "rsync") return out;
  const a = seg.argv;
  const target = a.some((w) => w === "-t" || w.startsWith("--target-directory"));
  const pos = a.filter((w) => !w.startsWith("-"));
  (target ? pos : pos.slice(0, -1)).forEach((w) => out.add(w));
  return out;
}

/** `ssh-keygen` flags of a fingerprint listing: `-l`, `-f`, `-v` (alone or combined, `-lf`) and `-E <alg>`; never `-y`, `-p`, `-c`, `-R`, `-s`. */
const KEYGEN_READ_FLAG = /^(?:-[lfv]+|-E|--)$/;

/** Which operands of a segment are only read: all of a read-only program (not `sort -o`, `--output`, `uniq`, `tree -o`), `ssh-keygen -l -f`. A copy's sources are not: a copy of a key stays a deny. */
function readOperands(seg: ShellSegment, prog: string): { argv: (w: string) => boolean } {
  const a = seg.argv;
  const writes = a.some((w) => /^--output(=|$)/.test(w)) || (prog === "sort" && a.some((w) => /^-[A-Za-z]*o|^--output/.test(w))) || (prog === "tree" && a.some((w) => /^-[A-Za-z]*o/.test(w))) || prog === "uniq";
  const all = (readOnlySegment(seg, prog) && !writes) || (prog === "ssh-keygen" && a.some((w) => /^-[fv]*l[fv]*$/.test(w)) && a.every((w) => !w.startsWith("-") || KEYGEN_READ_FLAG.test(w)));
  return { argv: () => all };
}

/**
 * A segment whose only opacity is a leading `~`, `$HOME` or `${HOME}` word (shellast.ts makes each `unresolved_var`): no other word holds a variable,
 * a substitution or a parenthesis. The floors expand these spellings themselves (expandWord).
 */
export function homeSpelling(s: ShellSegment): boolean {
  return s.opaque === "unresolved_var" && [s.program, ...s.argv, ...s.redirects.map((r) => r.target)].every((w) => !/[$`()]/.test(w.replace(/^\$\{?HOME\}?(?=\/|$)/, "")));
}

/**
 * The words of a shell line that are SSH public keys in `~/.ssh` (`sshPublicKey`) and are only read: operands of a read-only program, `<`
 * redirects. Empty for a line with an opaque segment, and a word that is also written anywhere on the line is left out.
 */
export function pubKeyReadWords(segments: ShellSegment[], env: FloorEnv, bound?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  // a line that binds HOME (or USERPROFILE on win32) reads another file than the one verified; a path-qualified program is no known reader
  if (bound && (bound.has("HOME") || (env.platform === "win32" && bound.has("USERPROFILE")))) return out;
  if (segments.length === 0 || segments.some((s) => (s.opaque !== null && !homeSpelling(s)) || s.wrappers.length > 0 || /[\\/]/.test(s.program))) return out;
  const written = new Set<string>();
  const cands = new Set<string>();
  for (const s of segments) {
    const prog = base(s.program);
    const reads = readOperands(s, prog);
    for (const r of s.redirects) {
      if (r.op === "<") cands.add(r.target);
      else if (r.op !== "dup") written.add(r.target);
    }
    for (const w of s.argv) (reads.argv(w) ? cands : written).add(w);
  }
  for (const w of cands) if (!written.has(w) && sshPublicKey(w, env)) out.add(w);
  return out;
}

const INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "bun", "deno", "perl", "ruby", "php", "lua", "rscript"]);
/** Code that writes, runs or removes something: a snippet with none of these is read-only. */
const WRITEISH = /\b(?:write|writelines|writeFile\w*|appendFile\w*|dump|dumps?_to|truncate|unlink|remove|rename|replace|rmtree|copy\w*|move|chmod|chown|system|popen|exec\w*|eval|subprocess|spawn\w*|fork|mkdir|touch|rm)\b|open\([^)]*['"][^'"]*[wxa+]|(?:^|[^=!<>-])>(?!=)|\bsed\s+-i/;

/** The words of the line that can carry a floored config key; the code of a read-only interpreter snippet is not one (pinned steward case 6). */
function lineKeyWords(line: ShellSegment[]): string[] {
  return line.flatMap((s) => {
    const ws = [s.program, ...s.argv, ...s.redirects.map((r) => r.target)];
    return INTERPRETERS.has(base(s.program)) && s.opaque === null ? ws.filter((w) => !(/\s/.test(w) && !WRITEISH.test(w))) : ws;
  });
}

/** `lineKeyWords` carries a floored key, once per line (every segment of the line asks). */
const lineKeys = new WeakMap<ShellSegment[], boolean>();
const hasKey = (line: ShellSegment[]): boolean => {
  let k = lineKeys.get(line);
  if (k === undefined) lineKeys.set(line, (k = lineKeyWords(line).some((w) => FLOOR_KEYS.test(w))));
  return k;
};

/** Floor: a shell write to a permissions file or harness state file, or to a foreman config file in a line that carries a floored key. */
function protectedWrite(seg: ShellSegment, prog: string, env: FloorEnv, line: ShellSegment[]): FloorHit | null {
  const cwd = seg.cwd ?? env.cwd;
  const entries = protectedEntries(env);
  const keys = hasKey(line);
  const configWord = (w: string): boolean => {
    if (!keys || dataWord(w)) return false;
    const abs = resolveWord(w.replace(/^[^=/]*=/, ""), cwd, env);
    return CONFIG_FILE.test(slash(abs ?? w)) && !(abs !== null && (inOwnTemp([abs], env) || editableSchema(abs, env)));
  };
  for (const r of seg.redirects) {
    if (r.op === "<" || r.op === "dup") continue;
    if (protectedWord(r.target, cwd, env, entries)) return protHit("This shell redirect writes", r.target);
    if (configWord(r.target)) return configHit("This shell redirect writes", r.target);
  }
  if (readOnlySegment(seg, prog)) return null;
  const src = copySourceWords(seg, prog);
  for (const w of seg.argv) {
    if (src.has(w)) continue;
    if (protectedWord(w, cwd, env, entries)) return protHit(`\`${prog}\` writes`, w);
    if (configWord(w)) return configHit(`\`${prog}\` writes`, w);
  }
  return null;
}

/**
 * A segment that parsed cleanly and only reads: a read-class program (a `find` with no action) or `git status|log|diff|show` with no program or output option,
 * and no redirect but a read, an fd dup or the null device. A config file it names is read, not written. A `~` or `$HOME` spelling is no opacity here (the floors expand it).
 */
function cleanReadSegment(seg: ShellSegment, env: FloorEnv): boolean {
  if ((seg.opaque !== null && !homeSpelling(seg)) || seg.heredoc || runsText(seg)) return false;
  if (!seg.redirects.every((r) => r.op === "<" || r.op === "dup" || NULL_TARGET.test(r.target))) return false;
  const p = base(seg.program);
  if (p === "git") {
    const call = gitCall(seg, env);
    return call !== null && call.overrides.length === 0 && GIT_READ.has(call.sub) && !gitReadWrites(call.rest);
  }
  return READ_CLASS.has(p) && !(p === "find" && seg.argv.some((a) => FIND_BAD.has(a)));
}

/**
 * The one segment of an unparsable line reads only when the statements a shell runs before the error (`beforeParseError`, as `completeLines` cuts) parse
 * cleanly and none of them writes. A cut that cannot be made (the first statement holds the error) counts as a write.
 */
function unparsedReads(text: string, seg: ShellSegment, env: FloorEnv): boolean {
  const prefix = beforeParseError(text);
  if (prefix === null) return false;
  const parsed = parseShell(prefix, { cwd: seg.cwd, platform: env.platform });
  return parsed.length > 0 && parsed.every((x) => x.opaque !== "parse_error" && nonWritingSegment(x, env));
}

/**
 * A segment that writes nothing the parser can see: a loop header, a bare assignment, a cleanly read segment, a read-only program (`sed` without `-i`, `jq`; git stays with `cleanReadSegment`, a `git add` stages) with no
 * redirect but a read, an fd dup or the null device and no text to run, or the one segment of an unparsable line (judged as a whole).
 */
function nonWritingSegment(seg: ShellSegment, env: FloorEnv, text = ""): boolean {
  if (seg.opaque === "parse_error") return unparsedReads(text, seg, env);
  if (seg.heredoc || runsText(seg) || !seg.redirects.every((r) => r.op === "<" || r.op === "dup" || NULL_TARGET.test(r.target))) return false;
  const p = base(seg.program);
  return LOOP_WORDS.has(p) || (p === "" && seg.opaque === "assignment" && seg.argv.length === 0) || cleanReadSegment(seg, env) || (p !== "git" && seg.wrappers.length === 0 && readOperands(seg, p).argv(""));
}

/**
 * Raw-text scan of an opaque line: a protected path, or a config file beside a floored key, in any word is an ASK (r79 item 4, Addendum S1).
 * A word that only a cleanly parsed read segment of `line` carries is a read: it is no hit (the segments judge the writes). On a line where no segment writes
 * (`nonWritingSegment`) a word no read segment carries (a loop variable, an assignment, unparsed text) goes to the judge instead of the owner or a deny.
 */
function opaqueProtected(text: string, env: FloorEnv, deny = false, line: ShellSegment[] = []): FloorHit | null {
  const flag = deny ? opaqueDeny : askHit;
  const entries = protectedEntries(env);
  // both spellings: split on braces and commas (the pieces of a brace group) and whole (a brace group inside one word is expanded by protectedWord)
  const wordsOf = (t: string): string[] => {
    const flat = t.replace(/\$(?=['"])/g, "").replace(/['"`]/g, "");
    return [...new Set([...flat.split(/[\s;&|<>(){},]+/), ...flat.split(/[\s;&|<>()]+/)])].filter(Boolean);
  };
  const unquote = (w: string): string => w.replace(/['"`]/g, "");
  const reading = line.length > 0 && line.every((s) => nonWritingSegment(s, env, text));
  const clean = line.filter((s) => cleanReadSegment(s, env));
  const reads = new Set(clean.flatMap((s) => s.argv.map(unquote)));
  // the split words of every other segment: a path inside a script argument (`sed -n "w $P"`) is carried by that segment, not read by the clean one
  const otherSegs = line.filter((s) => !clean.includes(s));
  const segWords = (s: ShellSegment): string[] => [s.program, ...s.argv, ...s.redirects.map((r) => r.target)];
  const others = new Set(otherSegs.flatMap((s) => segWords(s).flatMap(wordsOf)));
  // the silent exemption: every segment is a clean read, a loop word or a bare assignment; a `sed` or `jq` beside it may write what the parser cannot see, so a placed word goes to the judge
  const silent = line.every((s) => cleanReadSegment(s, env) || LOOP_WORDS.has(base(s.program)) || (base(s.program) === "" && s.opaque === "assignment" && s.argv.length === 0));
  const placed = (w: string): boolean => (!reading || silent) && reads.has(unquote(w)) && !others.has(unquote(w));
  // lifts judge to ask/deny for a split-off path; never weaker than the judge (a protected word inside a larger word of a segment that is neither a clean read nor a loop header, such as a sed `w` command the parser does not see as a write)
  const embedded = (w: string): boolean => otherSegs.some((s) => !LOOP_WORDS.has(base(s.program)) && segWords(s).some((x) => unquote(x) !== w && wordsOf(x).includes(w)));
  // a settings-file name that only a data here-document body holds is data (the key words are read from the whole text: a body written to a variable target still counts); a body fed to a shell or interpreter stays read
  // (`tee >(bash) <<E`: the body reaches a shell through a substitution the data test does not see)
  const data = dataBodies(line) && !line.some((s) => s.wrappers.includes("$(") && shellConsumer(s)) && bodiesOnlyCatTee(line, env);
  const words = wordsOf(data ? blankHeredocBodies(text) : text);
  // a Pi session file (`*.jsonl`) is no hit here: a line that only reads one (a transcript read through a path variable) is not refused; parsed write targets and path fields keep the entry
  const unread = entries.filter((e) => e.ext === undefined);
  const prot = words.filter((x) => protectedWord(x, env.cwd, env, unread));
  if (prot.length > 0) {
    const w = reading ? prot.find((x) => !placed(x)) : prot[0];
    if (w !== undefined) {
      const why = `The unparsed line names '${w.slice(0, 120)}', a permissions file or a harness state file.`;
      return reading && !embedded(w) ? judgeHit("policy-file", why, w) : flag("policy-file", why, w);
    }
  }
  if (UNREAD_KEYS.test(text)) {
    const c = words.find((x) => CONFIG_FILE.test(x) && !inOwnTemp([path.resolve(env.cwd, x)], env) && !(!/[$`*?[{~]/.test(x) && editableSchema(path.resolve(env.cwd, x), env)) && !((!reading || silent) && reads.has(x) && !others.has(x)));
    if (c !== undefined) {
      const why = `The unparsed line names the foreman config file '${c.slice(0, 120)}' next to a safety.permissions*, safety.policy* or gate.* key.`;
      return reading && !embedded(c) ? judgeHit("config-keys", why, c) : flag("config-keys", why, c);
    }
  }
  return null;
}

/** Floor: a write, edit, move or copy tool call whose written path is a policy or state file, or a foreman config file written with a floored key. */
function protectedToolWrite(tool: string, input: Record<string, unknown>, env: FloorEnv): FloorHit | null {
  const entries = protectedEntries(env);
  const moves = tool === "foreman_move" || tool === "foreman_copy";
  const keys = moves ? ["dst", ...(tool === "foreman_move" ? ["src"] : [])] : ["path", "file_path", "filePath"];
  const body = Object.entries(input).filter(([k, v]) => typeof v === "string" && !keys.includes(k)).map(([, v]) => v as string).concat(JSON.stringify(input.edits ?? ""));
  for (const k of keys) {
    const v = input[k];
    if (typeof v !== "string" || !v) continue;
    if (protectedWord(v, env.cwd, env, entries)) return protHit(`\`${tool}\` writes`, v);
    const abs = resolveWord(v, env.cwd, env);
    if (!moves && abs !== null && CONFIG_FILE.test(slash(abs)) && !inOwnTemp([abs], env) && !editableSchema(abs, env) && body.some((b) => FLOOR_KEYS.test(b))) return configHit(`\`${tool}\` writes`, v);
  }
  return null;
}
