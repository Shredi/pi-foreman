// A git repository built once per test file (the template) and copied into each test's own dir, instead of running init and clone again per test.
// The copy is a plain file copy, then every file's times are set to now; the paths git stores in it (remote urls, worktree links, alternates) name the template's dir, so every copy
// rewrites the template dir's basename to its own. The basename is unique and has no separator, so the native, forward-slash and
// backslash-escaped spellings of a path all match. Not a test: the test glob matches only *.test.ts.
import { after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { GIT_HOUSEKEEPING_OFF } from "./_git-housekeeping.mjs";

/** The settings a bare origin of a template gets: a local push starts receive-pack without the caller's GIT_CONFIG_* settings, so it needs these in its own config. */
export const BARE_ORIGIN_OFF: string[][] = [...GIT_HOUSEKEEPING_OFF, ["receive.autogc", "false"]];

export interface GitTemplate<T> {
  /** A fresh copy of the template: its root, and the value `build` returned (paths in it name the template; the caller recomputes them from the copy's root). */
  copy(): { root: string; built: T };
  /** Removes the template and every copy not yet removed. Also runs in an `after` hook. */
  dispose(): void;
}

/**
 * The template of a test file. Call at module scope: it registers its `after` hook there (a call inside a running test would attach to that test).
 * `parentDir` is called once, when the template is first built; the template and every copy are made under it (via mkdtemp, realpathed).
 * `build(root)` makes the repository under `root` with the caller's git calls; its work-tree and git files must not hold absolute paths outside `root`.
 */
export function gitTemplate<T>(parentDir: () => string, build: (root: string) => T): GitTemplate<T> {
  let tpl: { root: string; parent: string; built: T } | undefined;
  const copies = new Set<string>();
  const dispose = (): void => {
    for (const c of copies) fs.rmSync(c, { recursive: true, force: true });
    copies.clear();
    if (tpl) fs.rmSync(tpl.root, { recursive: true, force: true });
    tpl = undefined;
  };
  after(dispose);
  const mkdirReal = (parent: string, prefix: string): string => fs.realpathSync.native(fs.mkdtempSync(path.join(parent, prefix)));
  return {
    copy() {
      if (!tpl) {
        const parent = parentDir();
        const root = mkdirReal(parent, "pf-git-tpl-");
        let built: T;
        try {
          built = build(root);
        } catch (e) {
          fs.rmSync(root, { recursive: true, force: true });
          throw e;
        }
        tpl = { root, parent, built };
      }
      const dst = mkdirReal(tpl.parent, "pf-git-copy-");
      copies.add(dst);
      try {
        fs.cpSync(tpl.root, dst, { recursive: true });
        relink(tpl.root, dst);
        freshTimes(dst);
      } catch (e) {
        fs.rmSync(dst, { recursive: true, force: true });
        copies.delete(dst);
        throw e;
      }
      return { root: dst, built: tpl.built };
    },
    dispose,
  };
}

// files git reads a path from: the config of a repo, a worktree or a submodule, a worktree's gitdir/commondir, and a worktree's `.git` gitfile
const PATH_FILES = new Set(["config", "gitdir", "commondir", ".git", "alternates"]);

/** Every regular file under `dir`, except directories named in `skipDir` (symlinks are not followed); of a skipped `objects` dir only `info/alternates` is visited. */
function walkFiles(dir: string, skipDir: (name: string) => boolean, visit: (file: string) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDir(e.name)) walkFiles(file, skipDir, visit);
      else if (e.name === "objects") {
        const alternates = path.join(file, "info", "alternates");
        if (fs.existsSync(alternates)) visit(alternates);
      }
    } else if (e.isFile()) {
      visit(file);
    }
  }
}

/** Sets the atime and mtime of every regular file under `dir`, `.git` included, to now: on Windows cpSync keeps the source times even without preserveTimestamps, and the copy's files need their own (selffinish's `--since` reads them). */
function freshTimes(dir: string): void {
  const now = new Date();
  walkFiles(dir, () => false, (file) => fs.utimesSync(file, now, now));
}

/** Object and reflog dirs: git writes paths there but reads none back (a clone or fetch writes the source path into logs/ and FETCH_HEAD). */
const skipDirs = (name: string): boolean => name === "objects" || name === "logs";

/** Rewrites the template's basename to the copy's in every git file that names it, then fails if any other file still names it. */
function relink(tplRoot: string, dst: string): void {
  const from = path.basename(tplRoot);
  const to = path.basename(dst);
  walkFiles(dst, skipDirs, (file) => {
    if (!PATH_FILES.has(path.basename(file))) return;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(from)) rewrite(file, text.split(from).join(to));
  });
  walkFiles(dst, skipDirs, (file) => {
    const name = path.basename(file);
    if (name === "index" || name === "FETCH_HEAD") return;
    if (fs.readFileSync(file, "utf8").includes(from)) throw new Error(`git template: ${path.relative(dst, file)} still names the template ${from} after the copy`);
  });
}

/** Rewrites a file in place: on Windows git hides a worktree's `.git`, and writeFileSync's create-always open then fails with EPERM. */
function rewrite(file: string, text: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text, 0, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}
