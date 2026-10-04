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
//   that passes, compared before the foreman's next git command and before
//   foreman_worktree_remove. A change is an ask (never values, only which keys / hook files),
//   denied without a UI. Only file reads here; no git process is started.
//
// Limits: a change a child makes while the foreman's own git command runs is absorbed by the
// re-snapshot after that command; config outside the repo (global, system, includes that point
// outside the repo or its git dir) is not snapshotted (the include key itself is).
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
  hooksDir: string;
  hooks: Map<string, string>;
}

const sha = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

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
  const addConfig = (p: string, depth: number): void => {
    const lbl = label(p);
    if (files.has(lbl) || depth > 5) return;
    const text = readText(p);
    if (text === null) return;
    const entries = parseGitConfig(text);
    const grouped = new Map<string, string[]>();
    for (const [k, v] of entries) grouped.set(k, [...(grouped.get(k) ?? []), v]);
    files.set(lbl, { hash: sha(text), keys: new Map([...grouped].map(([k, vs]) => [k, sha(vs.join("\0"))])) });
    for (const [k, v] of entries) {
      if (k === "core.hookspath") hooksPath = v.replace(/^"(.*)"$/, "$1");
      if (!/^include(if\..*)?\.path$/.test(k)) continue;
      let target = v.replace(/^"(.*)"$/, "$1");
      if (target.startsWith("~/")) target = path.join(home, target.slice(2));
      target = path.resolve(path.dirname(p), target);
      if (roots.some((r) => inside(r, target))) addConfig(target, depth + 1);
    }
  };
  const addRaw = (p: string): void => {
    const text = readText(p);
    if (text !== null) files.set(label(p), { hash: sha(text), keys: null });
  };
  addConfig(path.join(repo.commonDir, "config"), 0);
  addConfig(path.join(repo.commonDir, "config.worktree"), 0);
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
  return { files, hooksDir, hooks };
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
  if (before.hooksDir !== after.hooksDir) out.push("hooks directory changed (core.hooksPath)");
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
  const msg = `The repository's git config or hooks changed since the last child launch (a child may have planted them; values are not shown):\n${summary}\nRun ${what} anyway? Inspect with \`git config --local --list --show-origin\` and the hooks directory first.`;
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
  return { decision: "no-ui", reason: `pi-foreman: the repository's git config or hooks changed since the last child launch, and there is no UI to approve ${what} (mode: ${ask.mode}); it is blocked.\n${summary}` };
}

/** Per-session state: the snapshot and the foreman git calls that passed the gate. */
export class GitDriftWatch {
  snap: GitSnapshot | null = null;
  private readonly passed = new Set<string>();

  /** Before a child launch that passed every other check (after `gate`). */
  snapshot(cwd: string, home: string): void {
    this.snap = takeGitSnapshot(cwd, home);
  }

  /** Before a foreman git command / worktree removal / child launch. Undefined = go on. */
  async gate(cwd: string, home: string, what: string, ask: DriftAskEnv, trace: (r: Record<string, unknown>) => void, callId?: string): Promise<{ block: true; reason: string } | undefined> {
    if (!this.snap) return undefined;
    const r = await checkGitDrift(this.snap, cwd, home, what, ask);
    if (r.decision !== "none") trace({ event: "git_config_drift", decision: r.decision });
    if (r.decision === "denied" || r.decision === "no-ui") return { block: true, reason: r.reason ?? "pi-foreman: git config drift." };
    if (r.decision === "approved") this.snap = takeGitSnapshot(cwd, home);
    if (callId) this.passed.add(callId);
    return undefined;
  }

  /** After the foreman's own git call ran: its own config changes (push -u, branch -d) become the baseline. */
  after(cwd: string, home: string, callId: string): void {
    if (!this.passed.delete(callId) || !this.snap) return;
    this.snap = takeGitSnapshot(cwd, home);
  }
}
