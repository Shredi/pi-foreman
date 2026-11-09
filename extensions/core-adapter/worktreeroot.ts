// The worktree root (`close.worktreeDir`): where the linked worktrees of a repo live. One resolver defines `<repo>` and the refusals; the Python
// counterpart is scripts/foreman_worktree.py (`main_checkout`, `resolve_worktree_root`), kept in step by tests/fixtures/worktree-root-cases.json.
// Also here: the nested-checkout rule (a git checkout that counts as part of a workspace tree, mirrored by scripts/safe_ops.py `nested_checkout`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { piAgentDir } from "./env.ts";
import { realDeep } from "./triage.ts";

export const DEFAULT_WORKTREE_DIR = "../<repo>.worktrees";
export const REPO_PLACEHOLDER = "<repo>";

export type RootErrorCode = "no_repo_placeholder" | "root_blocks_protected" | "root_inside_superproject";

export interface ResolveOptions {
  platform?: string;
  home?: string;
  agentDir?: string;
  tmpRoot?: string;
  /** pi-foreman package root (default: two levels above this file). */
  pkgRoot?: string;
  /** Roots only the TS side knows: the Pi install root and the global npm root. */
  installRoot?: string | null;
  npmRoot?: string | null;
  /** The superproject working tree of the main checkout; undefined = ask git (relative values only), null = none. */
  superproject?: string | null;
}

export interface ResolvedRoot {
  /** The root as written (absolute, normalised, symlinks kept). On an error: the default root. */
  spelled: string;
  /** `spelled` with the deepest existing ancestor resolved through symlinks. */
  real: string;
  /** Basename of the main checkout, a trailing `.git` dropped. */
  repoName: string;
  /** The value differs from the default layout. False on an error (consumers fall back to the default). */
  custom: boolean;
  /** `spelled` with `<repo>` still in it (one root per repo). */
  template: string;
  error?: { code: RootErrorCode; message: string };
  /** On an error: the root that was asked for. */
  requested?: string;
}

const flavour = (platform: string) => (platform === "win32" ? path.win32 : path.posix);
const folds = (platform: string) => platform === "win32" || platform === "darwin";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ------------------------------------------------------------------ git dir reading (filesystem only)

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The directory a `gitdir:` file points to, relative values resolved against the file's own directory. */
export function gitfileTarget(file: string): string | null {
  const m = /^gitdir:\s*(.+)$/m.exec(readText(file) ?? "");
  return m ? path.resolve(path.dirname(file), m[1].trim()) : null;
}

/** `value` of `key` in `[section]` of a git config file (no includes, subsections or continuations); null when absent. */
export function configValue(file: string, section: string, key: string): string | null {
  const text = readText(file);
  if (text === null) return null;
  let inSection = false;
  let found: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[\s*([A-Za-z0-9.-]+)(\s+"[^"]*")?\s*\]/.exec(line);
    if (head) {
      inSection = !head[2] && head[1].toLowerCase() === section;
      continue;
    }
    if (!inSection) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1].toLowerCase() !== key) continue;
    let v = kv[2].replace(/\s+[#;].*$/, "").trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    found = v;
  }
  return found;
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The `.git` entry found walking up from `start`: the work tree top, the git dir and the common dir (all real paths); null when none or unreadable. */
export function gitDirsAbove(start: string): { top: string; gitDir: string; common: string } | null {
  let cur = path.resolve(start);
  for (let n = 0; n < 64; n++) {
    const dot = path.join(cur, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(dot);
    } catch {
      st = null;
    }
    if (st) {
      const target = st.isFile() ? gitfileTarget(dot) : dot;
      const gitDir = target ? realOrNull(target) : null;
      if (!gitDir) return null;
      const rel = readText(path.join(gitDir, "commondir"))?.trim();
      const common = (rel ? realOrNull(path.resolve(gitDir, rel)) : null) ?? gitDir;
      return { top: realOrNull(cur) ?? cur, gitDir, common };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The main checkout of the repository holding `p` (real path), null when `p` lies in no repository. From the common git dir: its `core.worktree` when set
 * (a submodule: `worktree list` item 0 is the admin dir there), else the parent of a `.git` dir, else (a separate or bare git dir) `git worktree list` item 0.
 */
export function mainCheckoutOf(p: string): string | null {
  const dirs = gitDirsAbove(p);
  if (!dirs) return null;
  const cw = configValue(path.join(dirs.common, "config"), "core", "worktree");
  if (cw) return realOrNull(path.resolve(dirs.common, cw)) ?? path.resolve(dirs.common, cw);
  if (path.basename(dirs.common) === ".git") return path.dirname(dirs.common);
  const first = /^worktree (.+)$/m.exec(git(dirs.top, ["worktree", "list", "--porcelain"]) ?? "")?.[1];
  return first ? (realOrNull(first) ?? first) : null;
}

export function repoNameOf(mainCheckout: string, platform: string = process.platform): string {
  return flavour(platform).basename(mainCheckout).replace(/\.git$/, "");
}

// ------------------------------------------------------------------ the resolver

/** Same compilation as permoverlay.ts `wildcardRegExp` (`*` crosses `/`, `?` is one char); kept local so this module stays free of that import (a test pins the two together). */
function globRegExp(pattern: string, ignoreCase: boolean): RegExp {
  const escaped = pattern
    .replace(/\\/g, "/")
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\?/g, ".").replace(/\//g, () => "[\\\\/]"))
    .join(".*");
  return new RegExp(`^${escaped}$`, ignoreCase ? "si" : "s");
}

function inside(root: string, p: string, platform: string): boolean {
  const x = flavour(platform);
  const f = (s: string) => (folds(platform) ? s.toLowerCase() : s);
  const rel = x.relative(f(x.resolve(root)), f(x.resolve(p)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + x.sep) && !x.isAbsolute(rel));
}

function realFor(p: string, platform: string): string {
  return platform === process.platform ? realDeep(p) : p;
}

function protectedRoots(mainCheckout: string, o: ResolveOptions, platform: string): string[] {
  const home = o.home ?? os.homedir();
  const list = [mainCheckout, home, o.agentDir ?? piAgentDir(process.env, home), o.pkgRoot ?? PKG_ROOT, o.tmpRoot ?? os.tmpdir(), flavour(platform).parse(mainCheckout).root || "/"];
  if (o.installRoot) list.push(o.installRoot);
  if (o.npmRoot) list.push(o.npmRoot);
  return [...new Set(list.flatMap((r) => [r, realFor(r, platform)]))];
}

/** Superproject working tree of a submodule checkout, null for a plain repo. */
function superprojectOf(mainCheckout: string): string | null {
  const out = git(mainCheckout, ["rev-parse", "--show-superproject-working-tree"]);
  return out ? out.split(/\r?\n/)[0] : null;
}

/**
 * `close.worktreeDir` resolved for the repo whose main checkout is `mainCheckout`. Relative values resolve against the main checkout, `~` against home,
 * absolute values stand. An absolute or `~` value must hold `<repo>`. A refused value comes back as the default root with `error` (and `requested`) set.
 */
export function resolveWorktreeRoot(mainCheckout: string, rawSetting: unknown, opts: ResolveOptions = {}): ResolvedRoot {
  const platform = opts.platform ?? process.platform;
  const x = flavour(platform);
  const repoName = repoNameOf(mainCheckout, platform);
  const trimmed = typeof rawSetting === "string" ? rawSetting.trim() : "";
  const value = trimmed || DEFAULT_WORKTREE_DIR;
  const home = opts.home ?? os.homedir();
  const templateOf = (v: string): string => {
    const expanded = v === "~" || v.startsWith("~/") || v.startsWith("~\\") ? x.join(home, v.slice(1)) : v;
    return x.resolve(mainCheckout, expanded);
  };
  const defaultTemplate = templateOf(DEFAULT_WORKTREE_DIR);
  const mk = (template: string): ResolvedRoot => {
    const spelled = template.split(REPO_PLACEHOLDER).join(repoName);
    return { spelled, real: realFor(spelled, platform), repoName, custom: template !== defaultTemplate, template };
  };
  const dflt = (): ResolvedRoot => ({ ...mk(defaultTemplate), custom: false });
  const refuse = (code: RootErrorCode, message: string, requested: ResolvedRoot): ResolvedRoot => ({ ...dflt(), error: { code, message }, requested: requested.spelled });

  const tilde = value === "~" || value.startsWith("~/") || value.startsWith("~\\");
  const absolute = tilde || x.isAbsolute(value);
  const asked = mk(templateOf(value));
  if (absolute && !value.includes(REPO_PLACEHOLDER)) {
    return refuse("no_repo_placeholder", `close.worktreeDir \`${value}\` is an absolute path without \`<repo>\`; add \`<repo>\` so each repo gets its own folder (e.g. \`${value.replace(/[\\/]+$/, "")}/<repo>\`)`, asked);
  }
  if (!absolute && !tilde) {
    const sup = opts.superproject !== undefined ? opts.superproject : superprojectOf(mainCheckout);
    if (sup && (inside(sup, asked.spelled, platform) || inside(sup, asked.real, platform))) {
      return refuse("root_inside_superproject", `close.worktreeDir \`${value}\` puts the worktrees of the submodule ${repoName} inside its superproject (${sup}); use an absolute root such as \`~/worktrees/<repo>\``, asked);
    }
  }
  if (asked.template !== defaultTemplate) {
    const bad = blocksProtected(asked, protectedRoots(mainCheckout, opts, platform), platform);
    if (bad) return refuse("root_blocks_protected", `close.worktreeDir \`${value}\` would cover ${bad}, which children must keep reaching; choose a root that holds only worktrees (e.g. \`<repo>.wt\` beside a folder of its own)`, asked);
  }
  return asked.custom ? asked : { ...asked, custom: false };
}

/** The first protected root the root (or its block glob) covers, else null. */
function blocksProtected(r: ResolvedRoot, prot: string[], platform: string): string | null {
  const globs = rootGlobPatterns(r);
  const res = globs.map((g) => globRegExp(g, folds(platform)));
  for (const p of prot) {
    if (inside(r.spelled, p, platform) || inside(r.real, p, platform) || res.some((re) => re.test(p.replace(/\\/g, "/")) || re.test(p))) return p;
  }
  // (ii) a `<repo>` segment without an affix: everything at or under the fixed prefix is a repo folder
  const segs = r.template.split(flavour(platform).sep === "\\" ? /[\\/]/ : "/");
  const i = segs.findIndex((s) => s.includes(REPO_PLACEHOLDER));
  if (i >= 0 && segs[i] === REPO_PLACEHOLDER) {
    const prefix = segs.slice(0, i).join(flavour(platform).sep) || flavour(platform).sep;
    for (const p of prot) if (inside(prefix, p, platform)) return p;
  }
  return null;
}

/** The block patterns of a root: the template with `<repo>` → `*`, then `/*` (the round dirs' contents); spelled form and real-prefix form. */
function rootGlobPatterns(r: ResolvedRoot): string[] {
  const star = (t: string) => `${t.split(REPO_PLACEHOLDER).join("*").replace(/[\\/]+$/, "")}/*`;
  const out = [star(r.template)];
  const i = r.template.indexOf(REPO_PLACEHOLDER);
  const fixed = (i < 0 ? r.template : r.template.slice(0, Math.max(0, r.template.slice(0, i).search(/[^\\/]*$/)))).replace(/[\\/]+$/, "");
  const realFixed = realDeep(fixed || r.template);
  if (realFixed !== fixed) out.push(star(r.template.replace(fixed, realFixed)));
  return [...new Set(out)];
}

/**
 * The glob patterns that close a custom root to children: every repo's round dirs under it (the template with `<repo>` → `*`), in the spelled form and
 * with the fixed prefix resolved through symlinks. Empty for the default layout and for a refused value (the static `*.worktrees/*` glob covers those).
 */
export function rootTemplateGlobs(root: ResolvedRoot): string[] {
  return root.custom && !root.error ? rootGlobPatterns(root) : [];
}

// ------------------------------------------------------------------ root collision

/**
 * Another repo's worktree sitting directly in `root` (a child with a `.git` file whose main checkout differs from `mainCheckout`), else null.
 * Not a resolver error: checked when a worktree is created and by doctor, so the template block stays in force for every repo under a shared root.
 */
export function rootCollision(mainCheckout: string, root: string): { other: string; worktree: string; message: string } | null {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const mine = realOrNull(mainCheckout) ?? mainCheckout;
  for (const name of names.sort()) {
    const wt = path.join(root, name);
    try {
      if (!fs.lstatSync(path.join(wt, ".git")).isFile()) continue;
    } catch {
      continue;
    }
    const other = mainCheckoutOf(wt);
    if (other && other !== mine) {
      return { other, worktree: wt, message: `worktree root \`${root}\` already holds worktrees of \`${other}\`; rename one checkout or use a relative \`close.worktreeDir\`` };
    }
  }
  return null;
}

// ------------------------------------------------------------------ nested checkouts

function modulesRootsOf(r: string): string[] {
  const dirs = gitDirsAbove(r);
  if (!dirs || dirs.top !== (realOrNull(r) ?? r)) return [];
  return [...new Set([path.join(dirs.common, "modules"), path.join(dirs.gitDir, "modules")])];
}

function sameFile(a: string, b: string): boolean {
  const ra = realOrNull(path.dirname(a));
  const rb = realOrNull(path.dirname(b));
  return ra !== null && rb !== null && path.join(ra, path.basename(a)) === path.join(rb, path.basename(b));
}

function acceptsDirectly(roots: string[], c: string): boolean {
  const dot = path.join(c, ".git");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dot);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const target = gitfileTarget(dot);
  const admin = target ? realOrNull(target) : null;
  if (!admin) return false;
  const under = (base: string, p: string) => inside(base, p, "linux") && base !== p;
  const modules = roots.map((m) => realOrNull(m) ?? m);
  // (a) a linked worktree of a submodule: <M>/worktrees/<wt>, M below modules/, the back-link names this .git file
  const wtDir = path.dirname(admin);
  if (path.basename(wtDir) === "worktrees" && modules.some((m) => under(m, path.dirname(wtDir)))) {
    const back = readText(path.join(admin, "gitdir"))?.trim();
    if (back && sameFile(path.resolve(admin, back), dot)) return true;
  }
  // (b) a plain submodule checkout: admin dir below modules/ whose core.worktree is this checkout
  if (modules.some((m) => under(m, admin))) {
    const cw = configValue(path.join(admin, "config"), "core", "worktree");
    if (cw && realOrNull(path.resolve(admin, cw)) === (realOrNull(c) ?? c)) return true;
  }
  return false;
}

/**
 * `c` is a git checkout strictly inside the workspace tree rooted at `root`: its `.git` file points to a submodule admin dir below `<common(root)>/modules/`
 * or `<gitdir(root)>/modules/` and that dir names it back (a linked submodule worktree: the `gitdir` back-link; a plain submodule checkout: `core.worktree`).
 * Transitive: every checkout between `root` and `c` must be accepted too. Relative links resolve against the file that holds them.
 */
export function nestedCheckout(root: string, c: string): boolean {
  const r = realOrNull(root);
  const cc = realOrNull(c);
  if (!r || !cc || r === cc || !inside(r, cc, "linux")) return false;
  const roots = modulesRootsOf(r);
  if (!roots.length || !acceptsDirectly(roots, cc)) return false;
  for (let cur = path.dirname(cc); cur !== r && inside(r, cur, "linux"); cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, ".git")) && !acceptsDirectly(roots, cur)) return false;
  }
  return true;
}
