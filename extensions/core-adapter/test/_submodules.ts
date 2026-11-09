// Nested submodule fixture, built by hand the way an outside tool would (never by pi-foreman): clones, gitlinks via update-index, .gitmodules,
// absorbgitdirs, a linked superproject worktree with a linked submodule worktree (libs/a) and a plain submodule checkout (b) in it.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "protocol.file.allow=always", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

export interface SubmoduleRig {
  /** Superproject main checkout, with submodules libs/a and b (absorbed). */
  superproject: string;
  /** Linked worktree of the superproject, outside it. */
  tree: string;
  /** Linked worktree of submodule libs/a inside `tree`. */
  linkedSub: string;
  /** Plain submodule checkout b inside `tree` (git dir below the tree's own gitdir/modules). */
  plainSub: string;
  /** A linked worktree of submodule b below a plain (non-submodule) clone `tree/stray`: the intermediate checkout is not accepted. */
  strayInner: string;
  /** A foreign clone inside the linked submodule worktree. */
  foreign: string;
  /** A gitfile that points to b's admin dir but is not named back by it. */
  forged: string;
  /** Admin dir of submodule b below the superproject. */
  adminB: string;
}

/** `base` is a fresh empty dir (real path). Superproject at base/super, tree at base/super.worktrees/round. */
export function buildSubmoduleRig(base: string): SubmoduleRig {
  const src = path.join(base, "src");
  const superproject = path.join(base, "super");
  const tree = path.join(base, "super.worktrees", "round");
  for (const n of ["a", "b"]) {
    fs.mkdirSync(path.join(src, n), { recursive: true });
    gitIn(path.join(src, n), "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(src, n, "f"), `${n}\n`);
    gitIn(path.join(src, n), "add", "f");
    gitIn(path.join(src, n), "commit", "-q", "-m", "init");
  }
  fs.mkdirSync(superproject, { recursive: true });
  gitIn(superproject, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(superproject, "r"), "r\n");
  gitIn(superproject, "add", "r");
  gitIn(superproject, "commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(superproject, "libs"));
  gitIn(superproject, "clone", "-q", path.join(src, "a"), "libs/a");
  gitIn(superproject, "clone", "-q", path.join(src, "b"), "b");
  let mods = "";
  for (const [p, n] of [["libs/a", "a"], ["b", "b"]]) {
    gitIn(superproject, "update-index", "--add", "--cacheinfo", `160000,${gitIn(path.join(superproject, p), "rev-parse", "HEAD")},${p}`);
    mods += `[submodule "${p}"]\n\tpath = ${p}\n\turl = ${path.join(src, n)}\n`;
    gitIn(superproject, "config", `submodule.${p}.url`, path.join(src, n));
  }
  fs.writeFileSync(path.join(superproject, ".gitmodules"), mods);
  gitIn(superproject, "add", ".gitmodules");
  gitIn(superproject, "commit", "-q", "-m", "submodules");
  gitIn(superproject, "submodule", "absorbgitdirs");

  gitIn(superproject, "worktree", "add", "-q", "-b", "round", tree);
  const linkedSub = path.join(tree, "libs", "a");
  gitIn(path.join(superproject, "libs", "a"), "worktree", "add", "-q", "-b", "round", linkedSub);
  const plainSub = path.join(tree, "b");
  const adminTree = gitIn(tree, "rev-parse", "--absolute-git-dir");
  fs.mkdirSync(path.join(adminTree, "modules"), { recursive: true });
  gitIn(tree, "clone", "-q", "--separate-git-dir", path.join(adminTree, "modules", "b"), path.join(src, "b"), "b");
  // `git submodule` writes core.worktree into the module's config; a plain clone does not
  const adminPlain = path.join(adminTree, "modules", "b");
  gitIn(tree, "config", "--file", path.join(adminPlain, "config"), "core.worktree", path.relative(adminPlain, plainSub));

  const adminB = path.join(superproject, ".git", "modules", "b");
  const stray = path.join(tree, "stray");
  const strayInner = path.join(stray, "inner");
  gitIn(path.join(superproject, "b"), "worktree", "add", "-q", "-b", "stray", strayInner);
  gitIn(stray, "init", "-q");
  const foreign = path.join(linkedSub, "vendor", "foreign");
  fs.mkdirSync(foreign, { recursive: true });
  gitIn(foreign, "init", "-q");
  const forged = path.join(tree, "forged");
  fs.mkdirSync(forged);
  fs.writeFileSync(path.join(forged, ".git"), `gitdir: ${adminB}\n`);
  return { superproject, tree, linkedSub, plainSub, strayInner, foreign, forged, adminB };
}
