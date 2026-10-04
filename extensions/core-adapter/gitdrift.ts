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
//   scripts/safe_ops.py) and the main-mode git guard (it runs `git config`/`git diff --cached`
//   after the gate). A change is an ask (never values, only which keys / hook files), denied
//   without a UI. Only file reads here; no git process is started.
//   Covered: common dir config/config.worktree, in-repo includes, every linked worktree's
//   config.worktree/commondir/gitdir/.git file, info/attributes (common dir and per worktree),
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
}

export interface GitSnapshot {
  files: Map<string, FileSnap>;
  /** Hash of the hooks dir path (the path is a config value, so it is never stored). */
  hooksDirId: string;
  hooks: Map<string, string>;
}

export const sha =(s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Minimal git-config reader: key names (lower-cased section and name) and values. */
export function parseGitConfig(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
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
    if (!kv || !section) continue;
    out.push([`${section}.${kv[1].toLowerCase()}`, kv[2] === undefined ? "true" : kv[2].trim()]);
  }
  return out;
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
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
    const entries = parseGitConfig(text);
    const grouped = new Map<string, string[]>();
    for (const [k, v] of entries) grouped.set(k, [...(grouped.get(k) ?? []), v]);
    files.set(lbl, { hash: sha(text), keys: new Map([...grouped].map(([k, vs]) => [k, sha(vs.join("\0"))])) });
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
    addRaw(path.join(wd, "commondir"));
    addRaw(path.join(wd, "gitdir"));
    const dotGit = (readText(path.join(wd, "gitdir")) ?? "").trim();
    if (dotGit) {
      const text = readText(dotGit);
      if (text !== null) files.set(`worktree-git-file:${n}`, { hash: sha(text), keys: null });
    }
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
  return { files, hooksDirId: sha(hooksDir), hooks };
}

// ------------------------------------------------------------ persisted snapshots (names and hashes only)

/** State file for a workspace: `<stateDir>/<prefix>-<hash of the realpath of key>.json`. */
export function stateFileFor(stateDir: string, prefix: string, key: string): string {
  let real = key;
  try {
    real = fs.realpathSync(key);
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

/** Best effort: write via a temp file and rename. */
export function writeState(file: string | null, data: unknown): void {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {
    // The in-memory snapshot still works; the next session takes a fresh one.
  }
}

export function serializeGitSnapshot(s: GitSnapshot): unknown {
  return {
    v: 1,
    files: [...s.files].map(([l, f]) => [l, f.hash, f.keys ? [...f.keys] : null]),
    hooksDirId: s.hooksDirId,
    hooks: [...s.hooks],
  };
}

export function deserializeGitSnapshot(o: unknown): GitSnapshot | null {
  const r = o as { v?: number; files?: unknown; hooksDirId?: unknown; hooks?: unknown } | null;
  if (!r || r.v !== 1 || !Array.isArray(r.files) || typeof r.hooksDirId !== "string" || !Array.isArray(r.hooks)) return null;
  try {
    const files = new Map<string, FileSnap>();
    for (const [l, h, k] of r.files as Array<[string, string, Array<[string, string]> | null]>) {
      files.set(String(l), { hash: String(h), keys: Array.isArray(k) ? new Map(k.map(([a, b]) => [String(a), String(b)])) : null });
    }
    return { files, hooksDirId: r.hooksDirId, hooks: new Map((r.hooks as Array<[string, string]>).map(([a, b]) => [String(a), String(b)])) };
  } catch {
    return null;
  }
}

const MAX_ITEMS = 12;
const clean = (s: string): string => {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, "?");
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};

function listed(word: string, items: string[]): string | null {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_ITEMS).map(clean).join(", ");
  return `${word} ${shown}${items.length > MAX_ITEMS ? ` (+${items.length - MAX_ITEMS} more)` : ""}`;
}

/** What changed between two snapshots, as short lines naming files, keys and hooks (never values). Empty = no drift. */
export function diffGitSnapshots(before: GitSnapshot | null, after: GitSnapshot | null): string[] {
  if (!before) return [];
  if (!after) return ["the repository can no longer be found"];
  const out: string[] = [];
  const labels = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  for (const lbl of labels) {
    const a = before.files.get(lbl);
    const b = after.files.get(lbl);
    if (a && b && a.hash === b.hash) continue;
    if (!a && b) {
      out.push(`${clean(lbl)}: new file${b.keys && b.keys.size ? ` (${listed("keys", [...b.keys.keys()])})` : ""}`);
      continue;
    }
    if (a && !b) {
      out.push(`${clean(lbl)}: removed`);
      continue;
    }
    const ka = a!.keys ?? new Map<string, string>();
    const kb = b!.keys ?? new Map<string, string>();
    const added = [...kb.keys()].filter((k) => !ka.has(k));
    const removed = [...ka.keys()].filter((k) => !kb.has(k));
    const changed = [...kb.keys()].filter((k) => ka.has(k) && ka.get(k) !== kb.get(k));
    const parts = [listed("added", added), listed("changed", changed), listed("removed", removed)].filter(Boolean);
    out.push(`${clean(lbl)}: ${parts.length ? parts.join("; ") : "content changed"}`);
  }
  if (before.hooksDirId !== after.hooksDirId) out.push("hooks directory changed (core.hooksPath)");
  const hooks = [...new Set([...before.hooks.keys(), ...after.hooks.keys()])].sort();
  const hAdded = hooks.filter((h) => !before.hooks.has(h));
  const hRemoved = hooks.filter((h) => !after.hooks.has(h));
  const hChanged = hooks.filter((h) => before.hooks.has(h) && after.hooks.has(h) && before.hooks.get(h) !== after.hooks.get(h));
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
export async function checkGitDrift(before: GitSnapshot | null, cwd: string, home: string, what: string, ask: DriftAskEnv): Promise<{ decision: DriftDecision; reason?: string }> {
  const lines = diffGitSnapshots(before, before ? takeGitSnapshot(cwd, home) : null);
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
  private stateFile: string | null = null;
  private readonly passed = new Set<string>();

  private set(s: GitSnapshot | null): void {
    this.snap = s;
    if (s) writeState(this.stateFile, serializeGitSnapshot(s));
  }

  /**
   * Foreman session start: load the workspace's stored snapshot as the baseline and return
   * what changed since (empty = nothing, or no stored snapshot: then the current state is
   * taken silently). The next gate asks about the returned changes.
   */
  bind(stateDir: string, cwd: string, home: string): string[] {
    const repo = locateRepo(cwd);
    if (!repo) return [];
    this.stateFile = stateFileFor(stateDir, "gitdrift", repo.commonDir);
    const stored = deserializeGitSnapshot(readState(this.stateFile));
    if (!stored) {
      this.set(takeGitSnapshot(cwd, home));
      return [];
    }
    this.snap = stored;
    return diffGitSnapshots(stored, takeGitSnapshot(cwd, home));
  }

  /** Before a child launch that passed every other check (after `gate`). */
  snapshot(cwd: string, home: string): void {
    this.set(takeGitSnapshot(cwd, home));
  }

  /** Before a foreman git command / worktree removal / child launch. Undefined = go on. */
  async gate(cwd: string, home: string, what: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void, callId?: string): Promise<{ block: true; reason: string } | undefined> {
    if (!this.snap) return undefined;
    const r = await checkGitDrift(this.snap, cwd, home, what, ask);
    if (r.decision !== "none") trace({ event: "git_config_drift", decision: r.decision });
    if (r.decision === "denied" || r.decision === "no-ui") return { block: true, reason: r.reason ?? "pi-foreman: git config drift." };
    if (r.decision === "approved") this.set(takeGitSnapshot(cwd, home));
    if (callId) this.passed.add(callId);
    return undefined;
  }

  /** After the foreman's own git call ran: its own config changes (push -u, branch -d) become the baseline. */
  after(cwd: string, home: string, callId: string): void {
    if (!this.passed.delete(callId) || !this.snap) return;
    this.set(takeGitSnapshot(cwd, home));
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
