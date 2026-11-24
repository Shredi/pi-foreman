// Foreman-side git hygiene (security review cycle 2, T1).
//
// Worktrees share one `.git/config` and one hooks dir. A child with write tools can plant
// config (core.fsmonitor, url.<x>.insteadOf ext::, filter drivers, remote.<r>.pushurl, includes)
// or hooks there, for example through an allowed `npm test` that runs code it edited. The
// foreman's next own git command would then run that with the foreman's credentials.
//
// Two parts, foreman only (children have their own env patch, childenv.ts):
// - patchForemanGitEnv: appends `core.fsmonitor=false` and `protocol.ext.allow=never` to the
//   GIT_CONFIG_* list Pi's shell tools inherit. These two are the planted settings that run a
//   program on commands the foreman runs all the time (`git status`, `git fetch`) without any
//   hint in the command. `core.untrackedCache` is not added: it is a cache switch and runs
//   nothing. Repo hooks stay enabled (legitimate pre-commit hooks), so:
// - a snapshot of the repo's local git config files and hooks, taken before every child launch
//   that passes, compared before every foreman git run: the foreman's shell git commands, every
//   foreman safe op (foreman_move, foreman_copy, foreman_worktree_remove all run git through
//   scripts/safe_ops.py) and every foreman shell line that names git or a forge tool
//   (`mainNeedsGitGuard`). A change is an ask (never values, only which keys / hook files), denied
//   without a UI. Only file reads here; no git process is started.
//   Covered: common dir config/config.worktree, in-repo includes, every linked worktree's
//   config.worktree/gitdir/.git file (and whether commondir and .git file lead back to this repo;
//   git worktree add/remove bookkeeping is not reported), info/attributes (common dir and per worktree),
//   the hooks dir, and absorbed submodule git dirs (`modules/**`: config, info/attributes,
//   hooks/*), since `git status` runs submodule clean filters.
// - the snapshot is persisted per workspace (key: realpath of the git common dir) in the
//   pi-foreman state dir, as names and hashes only, and loaded at session start, so a change
//   planted during an earlier session asks too. With no stored snapshot (first session on a
//   workspace) the current state is taken silently as the baseline.
//
// Limits: a change a child makes while the foreman's own git command runs is absorbed by the
// re-snapshot after that command; config outside the repo (global, system, includes that point
// outside the repo or its git dir) is not snapshotted (the include key itself is); submodules
// whose `.git` is a directory inside their work tree (not absorbed) are not snapshotted; two
// foreman sessions on one workspace share the stored snapshot (last write wins).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendGitConfigEnv } from "./childenv.ts";
import type { Env } from "./env.ts";

export const FOREMAN_GIT_CONFIG: Array<[string, string]> = [
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
];

/** A line that may spell `.git` / `GIT~1` from pieces (`'.g''it'`, `".g"+"it"`). */
const SPLIT_TOKEN = /\.[\s'"\\$+]*g|g[\s'"\\$+]*i[\s'"\\$+]*t[\s'"\\$+]*~|~[\s'"\\+]*\d/i;

/**
 * The config-change check's trigger: the line names git or a PR cli (gh, glab, hub, tea), or may spell a guarded token from pieces.
 * A command that names none of them is not checked.
 */
export function mainNeedsGitGuard(command: unknown): boolean {
  return typeof command === "string" && (/git/i.test(command) || /\b(gh|glab|hub|tea)\b/i.test(command) || SPLIT_TOKEN.test(command));
}

/** Patch the foreman's process env (Pi's shell tools inherit it). Idempotent. */
export function patchForemanGitEnv(env: Env): void {
  appendGitConfigEnv(env, FOREMAN_GIT_CONFIG);
}

export interface RepoDirs {
  /** Worktree top level (the directory holding `.git`). */
  top: string;
  gitDir: string;
  commonDir: string;
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Find the repo of `cwd` by walking up to a `.git` dir or `gitdir:` file. File reads only. */
export function locateRepo(cwd: string): RepoDirs | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st) {
      let gitDir: string | null = null;
      if (st.isDirectory()) gitDir = dotGit;
      else if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
        if (m) gitDir = path.resolve(dir, m[1]);
      }
      if (gitDir) {
        const common = readText(path.join(gitDir, "commondir"));
        const commonDir = common && common.trim() ? path.resolve(gitDir, common.trim()) : gitDir;
        return { top: dir, gitDir, commonDir };
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Git toplevel of `cwd` (file reads only), or null outside a repo. */
export function workspaceTop(cwd: string): string | null {
  return locateRepo(cwd)?.top ?? null;
}

interface FileSnap {
  hash: string;
  /** Parsed config files: key -> hash of its values. Null for files that are not config. */
  keys: Map<string, string> | null;
  /** Raw values of branch.<b>.remote/.merge keys, in memory only (never serialized; absent on loaded snapshots). */
  raw?: Map<string, string[]>;
}

export interface GitSnapshot {
  files: Map<string, FileSnap>;
  /** Hash of the hooks dir path (the path is a config value, so it is never stored). */
  hooksDirId: string;
  hooks: Map<string, string>;
  /** Relative core.hooksPath only: the worktree top this snapshot was taken in (in memory; the hooks dir is per checkout). */
  relTop?: string;
  /** Relative core.hooksPath only: hooks map per worktree top (saved; absent on files from before and on other hooks dirs). */
  relTops?: Map<string, Map<string, string>>;
  /** Relative core.hooksPath only, in memory: the id the pre-fix formula gave for this checkout (sha of the resolved path). */
  legacyHooksDirId?: string;
}

const MAX_REL_TOPS = 32;
const MAX_PASSED_CALLS = 256;

/** Carry the per-top hooks maps of `prev` into `next` (same relative hooks path), dropping tops whose worktree is gone. */
export function mergeRelTops(prev: GitSnapshot | null, next: GitSnapshot): GitSnapshot {
  if (next.relTop === undefined) return next;
  const tops = new Map<string, Map<string, string>>();
  if (prev?.relTops && prev.hooksDirId === next.hooksDirId) {
    for (const [t, m] of prev.relTops) if (t !== next.relTop && fs.existsSync(t)) tops.set(t, m);
  }
  while (tops.size >= MAX_REL_TOPS) tops.delete(tops.keys().next().value as string);
  tops.set(next.relTop, next.hooks);
  return { ...next, relTops: tops };
}

export const sha =(s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Minimal git-config reader: key names (lower-cased section and name) and values. */
export function parseGitConfig(text: string): Array<[string, string]> {
  return parseGitConfigLines(text).entries;
}

/** Same reader, plus the lines it skipped (not comments, blank lines or empty section headers). */
export function parseGitConfigLines(text: string): { entries: Array<[string, string]>; skipped: string[] } {
  const out: Array<[string, string]> = [];
  const skipped: string[] = [];
  const lines = text.replace(/\\\r?\n/g, "").split(/\r?\n/);
  let section = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    let rest = line;
    const hdr = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(line);
    if (hdr) {
      const [name, ...sub] = hdr[1].split(".");
      section = hdr[2] !== undefined ? `${name.toLowerCase()}.${hdr[2].replace(/\\(.)/g, "$1")}` : [name.toLowerCase(), ...sub.map((x) => x.toLowerCase())].join(".");
      rest = hdr[3].trim();
      if (!rest || rest.startsWith("#") || rest.startsWith(";")) continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(rest);
    if (!kv || !section) {
      skipped.push(line);
      continue;
    }
    out.push([`${section}.${kv[1].toLowerCase()}`, kv[2] === undefined ? "true" : kv[2].trim()]);
  }
  return { entries: out, skipped };
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Same file or directory after resolving links (case-insensitive on Windows only; a mismatch reports, never hides). */
function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const [ra, rb] = [real(a), real(b)];
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Take a snapshot of the repo of `cwd`; null outside a repo. */
export function takeGitSnapshot(cwd: string, home: string): GitSnapshot | null {
  const repo = locateRepo(cwd);
  if (!repo) return null;
  const files = new Map<string, FileSnap>();
  const roots = [repo.top, repo.gitDir, repo.commonDir];
  const label = (p: string): string => {
    for (const [name, r] of [["git", repo.commonDir], ["gitdir", repo.gitDir], ["repo", repo.top]] as const) {
      if (inside(r, p)) return `${name}:${path.relative(r, p).split(path.sep).join("/") || "."}`;
    }
    return p;
  };
  let hooksPath: string | null = null;
  // `own` = false for submodule git dirs: their core.hooksPath is a key change, not this repo's hooks dir.
  const addConfig = (p: string, depth: number, own = true): void => {
    const lbl = label(p);
    if (files.has(lbl) || depth > 5) return;
    const text = readText(p);
    if (text === null) return;
    const { entries, skipped } = parseGitConfigLines(text);
    const grouped = new Map<string, string[]>();
    for (const [k, v] of entries) grouped.set(k, [...(grouped.get(k) ?? []), v]);
    // A line the reader cannot parse may be anything git does read: its hash is a key of its own, so a change in it is never silent.
    if (skipped.length) grouped.set(UNPARSED_KEY, [skipped.join("\n")]);
    const raw = new Map([...grouped].filter(([k]) => BRANCH_TRACKING.test(k)));
    files.set(lbl, { hash: sha(text), keys: new Map([...grouped].map(([k, vs]) => [k, sha(vs.join("\0"))])), raw });
    for (const [k, v] of entries) {
      if (k === "core.hookspath" && own) hooksPath = v.replace(/^"(.*)"$/, "$1");
      if (!/^include(if\..*)?\.path$/.test(k)) continue;
      let target = v.replace(/^"(.*)"$/, "$1");
      if (target.startsWith("~/")) target = path.join(home, target.slice(2));
      target = path.resolve(path.dirname(p), target);
      if (roots.some((r) => inside(r, target))) addConfig(target, depth + 1, own);
    }
  };
  const addRaw = (p: string): void => {
    const text = readText(p);
    if (text !== null) files.set(label(p), { hash: sha(text), keys: null });
  };
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const subdirs = (d: string): string[] => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  addConfig(path.join(repo.commonDir, "config"), 0);
  addConfig(path.join(repo.commonDir, "config.worktree"), 0);
  addRaw(path.join(repo.commonDir, "info", "attributes"));
  // Absorbed submodule git dirs: modules/<name>/ (names may contain `/`), nested under modules/<name>/modules/.
  let budget = 500;
  const walkModules = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const n of subdirs(dir)) {
      if (--budget < 0) return;
      const d = path.join(dir, n);
      if (!isFile(path.join(d, "config"))) {
        walkModules(d, depth + 1);
        continue;
      }
      addConfig(path.join(d, "config"), 0, false);
      addRaw(path.join(d, "info", "attributes"));
      let hookNames: string[] = [];
      try {
        hookNames = fs.readdirSync(path.join(d, "hooks")).sort();
      } catch {
        hookNames = [];
      }
      for (const h of hookNames) if (isFile(path.join(d, "hooks", h))) addRaw(path.join(d, "hooks", h));
      walkModules(path.join(d, "modules"), depth + 1);
    }
  };
  walkModules(path.join(repo.commonDir, "modules"), 0);
  // Linked worktrees: their own config and the files that say where their git dir is
  // (foreman_worktree_remove runs git inside one of them).
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(repo.commonDir, "worktrees")).sort();
  } catch {
    names = [];
  }
  for (const n of names) {
    const wd = path.join(repo.commonDir, "worktrees", n);
    addConfig(path.join(wd, "config.worktree"), 0);
    addRaw(path.join(wd, "info", "attributes"));
    // `commondir` is not stored and `gitdir` / the .git file only for content changes (git worktree
    // add/remove write and delete them, see diffGitSnapshots). A commondir that does not lead back to
    // this common dir, or a .git file that does not lead back to `wd`, would make git read config
    // from elsewhere: that is the derived `worktree-link:<n>` label, reported whenever it appears.
    addRaw(path.join(wd, "gitdir"));
    const common = readText(path.join(wd, "commondir"));
    const dotGit = (readText(path.join(wd, "gitdir")) ?? "").trim();
    const gitFile = dotGit ? path.resolve(wd, dotGit) : "";
    const text = gitFile ? readText(gitFile) : null;
    if (text !== null) files.set(`worktree-git-file:${n}`, { hash: sha(text), keys: null });
    const back = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
    const commonOk = !!common && !!common.trim() && samePath(path.resolve(wd, common.trim()), repo.commonDir);
    const fileOk = text === null || (!!back && samePath(path.resolve(path.dirname(gitFile), back[1]), wd));
    if (!commonOk || !fileOk) files.set(`worktree-link:${n}`, { hash: sha(`${common ?? ""}\0${text ?? ""}`), keys: null });
  }
  const hp = hooksPath as string | null;
  const hooksDir = hp
    ? path.resolve(repo.top, hp.startsWith("~/") ? path.join(home, hp.slice(2)) : hp)
    : path.join(repo.commonDir, "hooks");
  const hooks = new Map<string, string>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(hooksDir).sort();
  } catch {
    entries = [];
  }
  for (const name of entries) {
    try {
      const p = path.join(hooksDir, name);
      if (!fs.statSync(p).isFile()) continue;
      hooks.set(name, sha(fs.readFileSync(p)));
    } catch {
      hooks.set(name, "unreadable");
    }
  }
  // A relative value names a different dir in every checkout: one id per configured value, not per resolved path.
  if (hp && !hp.startsWith("~/") && !path.isAbsolute(hp)) {
    return { files, hooksDirId: sha(`rel\0${hp}`), hooks, relTop: repo.top, legacyHooksDirId: sha(hooksDir) };
  }
  return { files, hooksDirId: sha(hooksDir), hooks };
}

// ------------------------------------------------------------ persisted snapshots (names and hashes only)

/** State file for a workspace: `<stateDir>/<prefix>-<hash of the realpath of key>.json`. */
export function stateFileFor(stateDir: string, prefix: string, key: string): string {
  let real = key;
  try {
    // native: also expands Windows 8.3 short names, so the long spelling git writes into a worktree's .git file maps to the same file
    real = fs.realpathSync.native(key);
  } catch {
    real = path.resolve(key);
  }
  return path.join(stateDir, `${prefix}-${sha(real)}.json`);
}

export function readState(file: string | null): unknown {
  if (!file) return null;
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Best effort: write via a temp file and rename; then make sure the workspace's seen marker exists. */
export function writeState(file: string | null, data: unknown): void {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    markSeen(file);
  } catch {
    // The in-memory snapshot still works; the next session takes a fresh one.
  }
}

/**
 * Seen marker (security re-check R2-M1): `<state file minus .json>.seen`, created with the first
 * stored snapshot of a workspace and never removed by pi-foreman. A snapshot that is missing while
 * its marker exists, or that does not parse, is tampering, not a first session.
 */
function seenFile(file: string): string {
  return `${file.replace(/\.json$/, "")}.seen`;
}

function markSeen(file: string): void {
  try {
    fs.writeFileSync(seenFile(file), "pi-foreman: a drift snapshot existed for this workspace; do not delete\n", { flag: "wx" });
  } catch {
    // exists already (or the state dir is not writable: then no snapshot is stored either)
  }
}

/**
 * Load a stored snapshot. `parse` validates it (null = invalid). No file and no seen marker =
 * a true first session; no file with a marker, or a file that does not read, parse or validate =
 * tampered (the caller asks; without a UI it blocks).
 */
export function loadState<T>(file: string, what: string, parse: (o: unknown) => T | null): { kind: "first" } | { kind: "stored"; data: T } | { kind: "tampered"; line: string } {
  const text = readText(file);
  if (text === null) {
    if (!fs.existsSync(file) && !fs.existsSync(seenFile(file))) return { kind: "first" };
    return { kind: "tampered", line: `pi-foreman state: the stored ${what} snapshot for this workspace is ${fs.existsSync(file) ? "unreadable" : "missing"} (one existed before)` };
  }
  let data: T | null = null;
  try {
    data = parse(JSON.parse(text));
  } catch {
    data = null;
  }
  if (data === null) return { kind: "tampered", line: `pi-foreman state: the stored ${what} snapshot for this workspace is corrupt or truncated` };
  markSeen(file); // snapshots stored before the marker existed
  return { kind: "stored", data };
}

export function serializeGitSnapshot(s: GitSnapshot): unknown {
  return {
    v: 1,
    files: [...s.files].map(([l, f]) => [l, f.hash, f.keys ? [...f.keys] : null]),
    hooksDirId: s.hooksDirId,
    hooks: [...s.hooks],
    ...(s.relTops ? { relTops: [...s.relTops].map(([t, m]) => [t, [...m]]) } : {}),
  };
}

export function deserializeGitSnapshot(o: unknown): GitSnapshot | null {
  const r = o as { v?: number; files?: unknown; hooksDirId?: unknown; hooks?: unknown; relTops?: unknown } | null;
  if (!r || r.v !== 1 || !Array.isArray(r.files) || typeof r.hooksDirId !== "string" || !Array.isArray(r.hooks)) return null;
  try {
    const files = new Map<string, FileSnap>();
    for (const [l, h, k] of r.files as Array<[string, string, Array<[string, string]> | null]>) {
      files.set(String(l), { hash: String(h), keys: Array.isArray(k) ? new Map(k.map(([a, b]) => [String(a), String(b)])) : null });
    }
    const pairs = (m: unknown) => new Map((m as Array<[string, string]>).map(([a, b]): [string, string] => [String(a), String(b)]));
    const relTops = Array.isArray(r.relTops) ? new Map((r.relTops as Array<[string, unknown]>).map(([t, m]): [string, Map<string, string>] => [String(t), pairs(m)])) : undefined;
    return { files, hooksDirId: r.hooksDirId, hooks: pairs(r.hooks), ...(relTops ? { relTops } : {}) };
  } catch {
    return null;
  }
}

export const MAX_ITEMS = 12;
export const clean = (s: string): string => {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, "?");
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};

export function listed(word: string, items: string[]): string | null {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_ITEMS).map(clean).join(", ");
  return `${word} ${shown}${items.length > MAX_ITEMS ? ` (+${items.length - MAX_ITEMS} more)` : ""}`;
}

/**
 * Per-worktree labels (`git:worktrees/<n>/...`, `worktree-git-file:<n>`, `worktree-link:<n>`) -> worktree
 * name and what. `quiet` = the states git worktree add/remove produce and that cannot make git run
 * anything: new/removed of commondir (older snapshots), gitdir and the .git file (a new one that leads
 * elsewhere shows as `worktree-link`), and a removed `worktree-link` (worktree gone or leads back again).
 */
function worktreeLabel(lbl: string): { n: string; what: string; quiet: string[] } | null {
  const m = /^git:worktrees\/([^/]+)\/(.+)$/.exec(lbl);
  if (m) return { n: m[1], what: m[2], quiet: m[2] === "commondir" || m[2] === "gitdir" ? ["new", "removed"] : [] };
  const f = /^worktree-(git-file|link):(.+)$/.exec(lbl);
  if (!f) return null;
  return f[1] === "git-file" ? { n: f[2], what: ".git file", quiet: ["new", "removed"] } : { n: f[2], what: "link", quiet: ["removed"] };
}

const BRANCH_TRACKING = /^branch\..+\.(remote|merge|rebase)$/;

/**
 * D141: keys git writes into an absorbed submodule's `git:modules/<x>/config` (probed: `submodule add`, `submodule update --init`, `submodule status`
 * and `git -C sub worktree add` write only these, plus the routine branch tracking pair) and that cannot make git run a program. A change confined to
 * them is one grouped line; any other key (filter.*, core.hooksPath, core.fsmonitor, include.path, unknown) keeps its own file line.
 */
const QUIET_MODULE_KEYS = /^(?:core\.(?:worktree|bare|repositoryformatversion|filemode|logallrefupdates|ignorecase|precomposeunicode)|remote\.[^.]+\.(?:url|fetch))$/;
const MODULE_CONFIG = /^git:modules\/(.+)\/config$/;

/**
 * An added or changed branch.<b>.merge / branch.<b>.remote key that `worktree add -b`, `push -u` or
 * `checkout -b` write: merge only as refs/heads/<any name> while branch.<b>.remote names a safe remote; remote only as a name
 * whose remote.<name>.url is present in both snapshots with an unchanged hash (a URL or path value
 * has no such key). Raw values come from the `after` snapshot, in memory only.
 */
function routineTracking(key: string, a: FileSnap, b: FileSnap): boolean {
  const m = /^branch\.(.+)\.(remote|merge|rebase)$/.exec(key);
  const vals = b.raw?.get(key);
  if (!m || !vals || vals.length !== 1) return false;
  const v = vals[0];
  // r79 item 17: `branch.<b>.rebase` is written with the tracking pair (pull.rebase set up by `checkout -b` / `push -u`); only its plain values are routine
  if (m[2] === "rebase") return /^(?:true|false|merges)$/i.test(v);
  // any branch name: `worktree add -b X origin/main` writes branch.X.merge = refs/heads/main (owner ruling 2026-10-29)
  if (m[2] === "merge") return v === `refs/heads/${m[1]}` || (/^refs\/heads\/\S+$/.test(v) && routineRemote(m[1], a, b));
  return remoteUnchanged(v, a, b);
}

/** The remote name has a remote.<name>.url in both snapshots with an unchanged hash (a URL or path value has no such key). */
function remoteUnchanged(name: string, a: FileSnap, b: FileSnap): boolean {
  const url = `remote.${name}.url`;
  const [ua, ub] = [a.keys?.get(url), b.keys?.get(url)];
  return ua !== undefined && ua === ub;
}

/** branch.<b>.remote of the `after` snapshot names such a remote. */
function routineRemote(branch: string, a: FileSnap, b: FileSnap): boolean {
  const r = b.raw?.get(`branch.${branch}.remote`);
  return !!r && r.length === 1 && remoteUnchanged(r[0], a, b);
}

/**
 * Config keys whose change can run a program or redirect git (a value there is a command, a program path, a URL rewrite or proxy, a remote
 * target, a bundle URI, an include, or a switch of the repository, config or worktree git uses). Named by key shape: section, optional
 * subsection, variable (all lowercased). Method: every key of `git help config` (git 2.54, ~670 entries) was read; each whose description names
 * a command, program, hook, helper, tool, executable path, URL, proxy, include or such a switch is here, and a section most of whose keys
 * qualify (http, gpg, remote, ...) is here as a whole. Unsure keys stay in the class (fail closed); the extensions git ships later and
 * third-party sections (lfs) are covered by shape. Only these (plus hooks, info/attributes, includes and worktree links, which are other
 * snapshot parts, and unparsable config lines, see UNPARSED_KEY) open the drift ask; any other key (branch.<b>.vscode-merge-base,
 * branch.<b>.description, user.*, unknown) updates the baseline without a dialog.
 */
const EXEC_SECTIONS = new Set([
  "filter", "alias", "credential", "protocol", "sendemail", "pager", "difftool", "mergetool", "safe", "web", "browser", "man", "include",
  "hook", "guitool", "imap", "instaweb", "lfs", "ssh", "extensions", "bundle", "http", "gpg", "remote", "trace2", "fsmonitor",
]);
const EXEC_VARS: Record<string, RegExp> = {
  core: /^(?:fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|worktree|attributesfile|alternaterefscommand|bare|repositoryformatversion|unsetenvvars)$/,
  url: /^(?:insteadof|pushinsteadof)$/,
  diff: /^(?:textconv|command|external|tool|guitool)$/,
  merge: /^(?:driver|tool|guitool)$/,
  branch: /^(?:remote|merge|rebase|pushremote)$/,
  sequence: /^editor$/,
  interactive: /^difffilter$/,
  uploadpack: /^packobjectshook$/,
  receive: /^procreceiverefs$/,
  gc: /^(?:recentobjectshook|repackfilterto)$/,
  fetch: /^bundleuri$/,
  transfer: /^bundleuri$/,
  attr: /^tree$/,
  help: /^(?:browser|htmlpath)$/,
  submodule: /^(?:url|update|alternatelocation|gitdir)$/,
  init: /^templatedir$/,
  trailer: /^(?:cmd|command)$/,
  tar: /^command$/,
  includeif: /^path$/,
};

/** Synthetic key in a parsed config file's key map: a hash of the lines `parseGitConfig` could not read (never their text). */
export const UNPARSED_KEY = "(unparsed lines)";

/** True when a config key (dotted, lowercased) is in the exec-capable class above. */
function execCapableKey(key: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return true; // unparsable shape: fail closed
  const section = key.slice(0, first);
  const variable = key.slice(last + 1);
  if (EXEC_SECTIONS.has(section)) return true;
  return EXEC_VARS[section]?.test(variable) ?? false;
}

/** What changed between two snapshots, as short lines naming files, keys and hooks (never values). Empty = no drift. */
export function diffGitSnapshots(before: GitSnapshot | null, after: GitSnapshot | null): string[] {
  if (!before) return [];
  if (!after) return ["the repository can no longer be found"];
  const out: string[] = [];
  // Per-worktree changes collapse into one line (a repo with many worktrees would flood the ask).
  const wt = new Map<string, string[]>();
  const quietModules: string[] = [];
  const labels = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  for (const lbl of labels) {
    const a = before.files.get(lbl);
    const b = after.files.get(lbl);
    if (a && b && a.hash === b.hash) continue;
    const kind = !a ? "new" : !b ? "removed" : "changed";
    let state: string;
    const mod = b && b.keys !== null ? MODULE_CONFIG.exec(lbl) : null; // only a parsed config, not a hook that happens to be named config
    if (mod && kind === "new" && [...(b!.keys?.keys() ?? [])].every((k) => QUIET_MODULE_KEYS.test(k) || (BRANCH_TRACKING.test(k) && routineTracking(k, b!, b!)))) {
      quietModules.push(mod[1]);
      continue;
    }
    if (kind === "new") {
      const nk = b!.keys ? [...b!.keys.keys()] : [];
      const ek = nk.filter(execCapableKey);
      if (nk.length && !ek.length) continue; // only bookkeeping keys: no dialog
      state = `new file${nk.length ? ` (${listed("keys", ek)})` : ""}`;
    }
    else if (kind === "removed") state = "removed";
    else {
      const ka = a!.keys ?? new Map<string, string>();
      const kb = b!.keys ?? new Map<string, string>();
      // branch.<name>.remote/.merge appear and vanish with `worktree add -b`, `push -u`, `checkout -b`: routine, not drift.
      const routine = (k: string): boolean => BRANCH_TRACKING.test(k) && routineTracking(k, a!, b!);
      const added = [...kb.keys()].filter((k) => !ka.has(k) && !routine(k));
      const removed = [...ka.keys()].filter((k) => !kb.has(k) && !BRANCH_TRACKING.test(k));
      const changed = [...kb.keys()].filter((k) => ka.has(k) && ka.get(k) !== kb.get(k) && !routine(k));
      // Only keys that can run a program or redirect git are named; a change confined to other keys updates the baseline without a dialog.
      const [eAdded, eChanged, eRemoved] = [added, changed, removed].map((ks) => ks.filter(execCapableKey));
      if (added.length + changed.length + removed.length && !eAdded.length && !eChanged.length && !eRemoved.length) continue;
      const parts = [listed("added", eAdded), listed("changed", eChanged), listed("removed", eRemoved)].filter(Boolean);
      const onlyTracking = !parts.length && [...ka.keys(), ...kb.keys()].some((k) => BRANCH_TRACKING.test(k) && ka.get(k) !== kb.get(k));
      if (onlyTracking) continue;
      if (mod && parts.length && [...eAdded, ...eChanged, ...eRemoved].every((k) => QUIET_MODULE_KEYS.test(k))) {
        quietModules.push(mod[1]);
        continue;
      }
      state = parts.length ? parts.join("; ") : "content changed";
    }
    const w = worktreeLabel(lbl);
    if (!w) {
      out.push(`${clean(lbl)}: ${state}`);
      continue;
    }
    if (w.quiet.includes(kind)) continue;
    const item = w.what === "link" ? "commondir or .git file points outside this repository" : `${clean(w.what)} ${state}`;
    wt.set(w.n, [...(wt.get(w.n) ?? []), item]);
  }
  if (wt.size) {
    const items = [...wt].slice(0, MAX_ITEMS).map(([n, xs]) => `${clean(n)}: ${xs.join(", ")}`);
    out.push(`worktrees: ${wt.size} changed (${items.join("; ")}${wt.size > MAX_ITEMS ? `; +${wt.size - MAX_ITEMS} more` : ""})`);
  }
  if (quietModules.length) out.push(`submodule configs: ${quietModules.length} changed (${quietModules.slice(0, MAX_ITEMS).map(clean).join("; ")}${quietModules.length > MAX_ITEMS ? `; +${quietModules.length - MAX_ITEMS} more` : ""})`);
  // Relative core.hooksPath: an old-formula id for this checkout counts as unchanged; the baseline hooks are the
  // stored map of this very worktree top (a top seen first time is its own baseline: no hook drift).
  const legacy = after.relTop !== undefined && before.relTops === undefined && before.hooksDirId === after.legacyHooksDirId;
  if (before.hooksDirId !== after.hooksDirId && !legacy) out.push("hooks directory changed (core.hooksPath)");
  let beforeHooks: Map<string, string> | undefined = before.hooks;
  if (after.relTop !== undefined && !legacy && before.hooksDirId === after.hooksDirId) beforeHooks = before.relTops?.get(after.relTop);
  if (beforeHooks === undefined) beforeHooks = after.hooks;
  const hooks = [...new Set([...beforeHooks.keys(), ...after.hooks.keys()])].sort();
  const hAdded = hooks.filter((h) => !beforeHooks.has(h));
  const hRemoved = hooks.filter((h) => !after.hooks.has(h));
  const hChanged = hooks.filter((h) => beforeHooks.has(h) && after.hooks.has(h) && beforeHooks.get(h) !== after.hooks.get(h));
  const hp = [listed("added", hAdded), listed("changed", hChanged), listed("removed", hRemoved)].filter(Boolean);
  if (hp.length) out.push(`hooks: ${hp.join("; ")}`);
  return out;
}

export interface DriftAskEnv {
  mode: string;
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

export type DriftDecision = "none" | "approved" | "denied" | "no-ui";

/**
 * Compare `before` with the repo now. No change -> "none". A change -> confirm in TUI/RPC with
 * a UI, otherwise "no-ui" (blocked). The caller re-snapshots after "approved".
 */
export async function checkGitDrift(before: GitSnapshot | null, cwd: string, home: string, what: string, ask: DriftAskEnv, extra: string[] = []): Promise<{ decision: DriftDecision; reason?: string }> {
  const lines = [...extra, ...diffGitSnapshots(before, before ? takeGitSnapshot(cwd, home) : null)];
  if (!lines.length) return { decision: "none" };
  const summary = lines.join("\n");
  const msg = `The repository's git config or hooks changed since pi-foreman last checked them (last child launch, own git call or an earlier session; a child may have planted them; values are not shown):\n${summary}\nRun ${what} anyway? Inspect with \`git config --local --list --show-origin\` and the hooks directory first.`;
  if ((ask.mode === "tui" || ask.mode === "rpc") && ask.hasUI && ask.confirm) {
    let ok = false;
    try {
      ok = await ask.confirm("pi-foreman: git config changed", msg);
    } catch {
      ok = false;
    }
    if (ok) return { decision: "approved" };
    return { decision: "denied", reason: `Denied by the user. pi-foreman: git config drift.\n${summary}` };
  }
  return { decision: "no-ui", reason: `pi-foreman: the repository's git config or hooks changed since pi-foreman last checked them, and there is no UI to approve ${what} (mode: ${ask.mode}); it is blocked.\n${summary}` };
}

/** Per-session state: the snapshot and the foreman git calls that passed the gate. */
export class GitDriftWatch {
  snap: GitSnapshot | null = null;
  /** True when bind found no snapshot and no seen marker and took the baseline (shown to the user). */
  firstBaseline = false;
  /** Set when the stored snapshot was missing or corrupt for a workspace that had one; asks until approved. */
  tamper: string | null = null;
  private stateFile: string | null = null;
  /** Call id -> the cwd `gate` compared; `after` re-snapshots that checkout, never one the gate did not compare. */
  private readonly passed = new Map<string, string>();

  private set(s: GitSnapshot | null): void {
    if (s) s = mergeRelTops(this.snap, s);
    this.snap = s;
    if (s) writeState(this.stateFile, serializeGitSnapshot(s));
  }

  /**
   * Foreman session start: load the workspace's stored snapshot as the baseline and return
   * what changed since (empty = nothing, or a true first session: then the current state is
   * taken and `firstBaseline` is set for a visible notice). A missing or corrupt snapshot for a
   * workspace that had one is returned as a drift line. The next gate asks about the returned changes.
   */
  bind(stateDir: string, cwd: string, home: string): string[] {
    const repo = locateRepo(cwd);
    if (!repo) return [];
    this.stateFile = stateFileFor(stateDir, "gitdrift", repo.commonDir);
    const st = loadState(this.stateFile, "git config", deserializeGitSnapshot);
    if (st.kind !== "stored") {
      this.firstBaseline = st.kind === "first";
      this.tamper = st.kind === "tampered" ? st.line : null;
      this.snap = takeGitSnapshot(cwd, home);
      if (st.kind === "first") this.set(this.snap);
      return this.tamper ? [this.tamper] : [];
    }
    this.snap = st.data;
    return diffGitSnapshots(st.data, takeGitSnapshot(cwd, home));
  }

  /** Before a child launch that passed every other check (after `gate`). */
  snapshot(cwd: string, home: string): void {
    this.set(takeGitSnapshot(cwd, home));
  }

  /** Before a foreman git command / worktree removal / child launch. Undefined = go on. */
  async gate(cwd: string, home: string, what: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void, callId?: string): Promise<{ block: true; reason: string } | undefined> {
    if (!this.snap) return undefined;
    const r = await checkGitDrift(this.snap, cwd, home, what, ask, this.tamper ? [this.tamper] : []);
    if (r.decision !== "none") trace({ event: "git_config_drift", decision: r.decision });
    if (r.decision === "denied" || r.decision === "no-ui") return { block: true, reason: r.reason ?? "pi-foreman: git config drift." };
    if (r.decision === "approved") {
      this.tamper = null;
      this.set(takeGitSnapshot(cwd, home));
    }
    else if (r.decision === "none") this.recordFirstSeenTop(cwd, home);
    if (callId) {
      this.passed.delete(callId);
      while (this.passed.size >= MAX_PASSED_CALLS) this.passed.delete(this.passed.keys().next().value as string);
      this.passed.set(callId, cwd);
    }
    return undefined;
  }

  /**
   * Before `foreman_worktree_remove` of a worktree that belongs to another clone: that clone's git config and hooks run git too, so its own stored snapshot
   * (`<stateDir>` per common dir, like the session's) is compared; a first sight takes the baseline. Undefined = the target is in the session's repository (the
   * normal `gate` covers it), has no repository, or nothing changed.
   */
  async gateTargetRepo(stateDir: string, target: string, sessionCwd: string, home: string, what: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void): Promise<{ block: true; reason: string } | undefined> {
    const other = locateRepo(target);
    const own = locateRepo(sessionCwd);
    if (!other || (own && samePath(other.commonDir, own.commonDir))) return undefined;
    const file = stateFileFor(stateDir, "gitdrift", other.commonDir);
    const st = loadState(file, "git config", deserializeGitSnapshot);
    const now = takeGitSnapshot(target, home);
    if (st.kind === "first") {
      if (now) writeState(file, serializeGitSnapshot(now));
      return undefined;
    }
    const r = await checkGitDrift(st.kind === "stored" ? st.data : now, target, home, what, ask, st.kind === "tampered" ? [st.line] : []);
    if (r.decision !== "none") trace({ event: "git_config_drift", decision: r.decision, repo: "target" });
    if (r.decision === "denied" || r.decision === "no-ui") return { block: true, reason: r.reason ?? "pi-foreman: git config drift." };
    if (r.decision === "approved" && now) writeState(file, serializeGitSnapshot(now));
    return undefined;
  }

  /** No drift in a checkout whose relative hooks dir has no stored map yet: store that top's hooks as its baseline (the rest of the stored snapshot stays). */
  private recordFirstSeenTop(cwd: string, home: string): void {
    const prev = this.snap;
    if (!prev?.relTops) return;
    const cur = takeGitSnapshot(cwd, home);
    if (!cur || cur.relTop === undefined || cur.hooksDirId !== prev.hooksDirId || prev.relTops.has(cur.relTop)) return;
    const tops = new Map<string, Map<string, string>>();
    for (const [t, m] of prev.relTops) if (fs.existsSync(t)) tops.set(t, m);
    while (tops.size >= MAX_REL_TOPS) tops.delete(tops.keys().next().value as string);
    tops.set(cur.relTop, cur.hooks);
    this.snap = { ...prev, relTops: tops };
    writeState(this.stateFile, serializeGitSnapshot(this.snap));
  }

  /** After the foreman's own git call ran: its own config changes (push -u, branch -d) become the baseline. */
  after(cwd: string, home: string, callId: string): void {
    const gated = this.passed.get(callId) ?? cwd;
    if (!this.passed.delete(callId) || !this.snap) return;
    this.set(takeGitSnapshot(gated, home));
  }
}

/**
 * Preflight for the foreman safe ops (safeops.ts): every op runs git through safe_ops.py
 * (move: ls-files/status/mv, which run clean filters; copy: rev-parse; worktree_remove:
 * status/worktree/branch), so each one is gated. Children are not gated here.
 */
export function safeOpDriftPreflight(watch: GitDriftWatch, isChild: boolean, cwd: string, home: string, op: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void, callId: string): Promise<{ block: true; reason: string } | undefined> {
  if (isChild) return Promise.resolve(undefined);
  return watch.gate(cwd, home, `foreman_${op}`, ask, trace, callId);
}
