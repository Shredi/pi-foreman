// Run-end state hint, the case list of plan readonly-target E (picture): one fixture repo with a submodule and an uninitialized gitlink, real git.
// The git-stage changes run cumulatively against one start picture (each step asserts its own line); the settings changes run against a second start and
// need no git at the end (the git stage gate), so they are cheap.
import "./_hermetic-env.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitIn } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { GATED_LINE, END_UNREADABLE, COMPARE_FAILED, diffReadonlyState, spawnGit, takeReadonlyState, type GitRunner, type Picture } from "../readonlystate.ts";

const skip = process.platform === "win32" ? "POSIX fixture (FIFO, symlink, hook modes)" : false;
let base = "";
let repo = "";
let src = "";
const home = os.homedir();
const w = (rel: string, text: string): void => fs.writeFileSync(path.join(repo, rel), text);
/** A git runner that counts its runs and keeps their directories. */
const counting = (): { run: GitRunner; cwds: string[] } => {
  const cwds: string[] = [];
  return { run: (cwd, args, sig) => (cwds.push(cwd), spawnGit(cwd, args, sig)), cwds };
};
const pic = (root = repo, g: GitRunner = spawnGit) => takeReadonlyState(root, home, g);
const lines = async (start: Picture, g: GitRunner = spawnGit, root = repo): Promise<string[]> => diffReadonlyState(start, await takeReadonlyState(root, home, g, start));
const joined = (l: string[]): string => l.join(" | ");

before(() => {
  base = fs.realpathSync(mkTestTmp("pf-ro-cases-"));
  src = path.join(base, "src");
  repo = path.join(base, "repo");
  fs.mkdirSync(src);
  gitIn(src, "init", "-q", "-b", "main");
  for (const n of ["s.txt", "t.txt"]) fs.writeFileSync(path.join(src, n), `${n}\n`);
  gitIn(src, "add", ".");
  gitIn(src, "commit", "-q", "-m", "s");
  fs.mkdirSync(repo);
  gitIn(repo, "init", "-q", "-b", "main");
  for (const n of "abcdefgh") w(`${n}.txt`, `${n}\n`);
  fs.mkdirSync(path.join(repo, ".workflow"));
  w(".workflow/n.md", "n\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  gitIn(repo, "submodule", "add", "-q", src, "sub");
  gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${gitIn(src, "rev-parse", "HEAD")},sub2`);
  gitIn(repo, "commit", "-q", "-m", "sub");
  // dirty at the start: d.txt, e.txt, and t.txt inside the submodule
  w("d.txt", "d1\n");
  w("e.txt", "e1\n");
  fs.writeFileSync(path.join(repo, "sub", "t.txt"), "t1\n");
});
after(() => rmTestTmp(base));

test("git stage: every change named, every non-change silent (one start picture)", { skip }, async (t) => {
  const s1 = await pic();
  const timed = <T>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hang")), 20_000).unref())]);

  await t.test("no line for: status and diff runs, same-bytes rewrite of a dirty file, another branch, a tag, refs/stash, untracked, .workflow, objects, a linked worktree with branch.other.* keys, its config.worktree", async () => {
    gitIn(repo, "status");
    gitIn(repo, "diff");
    w("d.txt", "d1\n");
    gitIn(repo, "branch", "other");
    gitIn(repo, "tag", "v1");
    gitIn(repo, "update-ref", "refs/stash", "HEAD");
    w("untracked.txt", "u\n");
    w(".workflow/n.md", "changed\n");
    gitIn(repo, "hash-object", "-w", "untracked.txt");
    const wt = path.join(base, "wt");
    gitIn(repo, "worktree", "add", "-q", "-b", "wtb", wt, "HEAD");
    gitIn(repo, "config", "branch.wtb.remote", "origin");
    gitIn(repo, "config", "branch.wtb.merge", "refs/heads/wtb");
    fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "config.worktree"), "[user]\n\tname = x\n");
    assert.deepEqual(await lines(s1), []);
    fs.rmSync(path.join(repo, ".workflow", "n.md"));
  });
  await t.test("a second edit of a file dirty at the start; a dirty file restored to clean", async () => {
    w("d.txt", "d2\n");
    assert.match(joined(await lines(s1)), /tracked files changed.*d\.txt/);
    gitIn(repo, "checkout", "-q", "--", "e.txt");
    assert.match(joined(await lines(s1)), /tracked files changed.*e\.txt/);
  });
  await t.test("a tracked file edited and one deleted", async () => {
    w("a.txt", "a changed\n");
    fs.rmSync(path.join(repo, "b.txt"));
    const l = joined(await lines(s1));
    assert.match(l, /tracked files changed.*a\.txt/);
    assert.match(l, /tracked files changed.*b\.txt/);
  });
  await t.test("a tracked file replaced by a symlink to a directory and by a FIFO: no throw, no hang", async () => {
    fs.rmSync(path.join(repo, "g.txt"));
    fs.symlinkSync("sub", path.join(repo, "g.txt"));
    fs.rmSync(path.join(repo, "h.txt"));
    execFileSync("mkfifo", [path.join(repo, "h.txt")]);
    const l = joined(await timed(lines(s1)));
    assert.match(l, /tracked files changed.*g\.txt/);
    assert.match(l, /tracked files changed.*h\.txt/);
    assert.ok(!l.includes(END_UNREADABLE) && !l.includes(COMPARE_FAILED), l);
  });
  await t.test("git add, and update-index --assume-unchanged (the flag letter is in the index picture)", async () => {
    w("c.txt", "c2\n");
    gitIn(repo, "add", "c.txt");
    assert.match(joined(await lines(s1)), /index entries changed.*c\.txt/);
    gitIn(repo, "update-index", "--assume-unchanged", "f.txt");
    assert.match(joined(await lines(s1)), /index entries changed.*f\.txt/);
  });
  await t.test("submodule: an edit, a second edit of a file dirty at the start, a commit", async () => {
    const sub = path.join(repo, "sub");
    fs.writeFileSync(path.join(sub, "s.txt"), "s edited\n");
    assert.match(joined(await lines(s1)), /sub: tracked files changed.*s\.txt/);
    fs.writeFileSync(path.join(sub, "t.txt"), "t2\n");
    assert.match(joined(await lines(s1)), /sub: tracked files changed.*t\.txt/);
    gitIn(sub, "commit", "-q", "-a", "-m", "in sub");
    assert.match(joined(await lines(s1)), /sub: HEAD [0-9a-f]{8} -> [0-9a-f]{8}/);
  });
  await t.test("a gitlink initialized during the run and a new gitlink: reported, no git run in it, planted filter marker absent", async () => {
    const marker = path.join(base, "MARKER-sub");
    const sub2 = path.join(repo, "sub2");
    gitIn(base, "clone", "-q", src, sub2);
    gitIn(sub2, "config", "filter.x.clean", `touch ${marker}`);
    fs.writeFileSync(path.join(sub2, ".git", "info", "attributes"), "* filter=x\n");
    fs.writeFileSync(path.join(sub2, "s.txt"), "edited in sub2\n");
    const c = counting();
    assert.match(joined(await lines(s1, c.run)), /new submodule\(s\), not compared: sub2/);
    gitIn(base, "clone", "-q", src, path.join(repo, "newsub"));
    gitIn(repo, "add", "newsub");
    const c2 = counting();
    const l = joined(await lines(s1, c2.run));
    assert.match(l, /index entries changed.*newsub/);
    assert.match(l, /new submodule\(s\), not compared:.*newsub/);
    assert.ok(![...c.cwds, ...c2.cwds].some((d) => d.startsWith(sub2) || d.startsWith(path.join(repo, "newsub"))), "no git run in a new submodule");
    assert.equal(fs.existsSync(marker), false);
  });
  await t.test("a commit and a move of the current branch name the new HEAD; a branch switch names the branch", async () => {
    gitIn(repo, "commit", "-q", "-m", "x");
    const committed = gitIn(repo, "rev-parse", "HEAD");
    assert.match(joined(await lines(s1)), new RegExp(`HEAD [0-9a-f]{8} -> ${committed.slice(0, 8)}`));
    const moved = gitIn(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "moved");
    gitIn(repo, "update-ref", "refs/heads/main", moved);
    assert.match(joined(await lines(s1)), new RegExp(`HEAD [0-9a-f]{8} -> ${moved.slice(0, 8)}`));
    gitIn(repo, "checkout", "-q", "-b", "newb");
    assert.match(joined(await lines(s1)), /branch main -> newb/);
  });
  await t.test("branch.<round>.merge of the end branch is named (by key, not value)", async () => {
    gitIn(repo, "config", "branch.newb.merge", "refs/heads/VALUEMARK");
    const l = joined(await lines(s1));
    assert.match(l, /branch\.newb\.merge/i);
    assert.ok(!l.includes("VALUEMARK"));
  });
});

test("settings: every change is named by key, no git runs at the end, files are not compared", { skip }, async (t) => {
  const s2 = await pic();
  const check = async (what: string, mutate: () => void, undo: () => void, expect: RegExp, extra?: (l: string, cwds: string[]) => void): Promise<void> => {
    await t.test(what, async () => {
      mutate();
      try {
        const c = counting();
        const l = joined(await lines(s2, c.run));
        assert.equal(c.cwds.length, 0, `git ran: ${c.cwds.join(",")}`);
        assert.match(l, expect, l);
        assert.ok(l.includes(GATED_LINE), l);
        extra?.(l, c.cwds);
      } finally {
        undo();
      }
    });
  };
  const gitDir = path.join(repo, ".git");
  await check("a config key: the name shows, the value does not", () => gitIn(repo, "config", "user.zname", "VALUEXYZ"), () => gitIn(repo, "config", "--unset", "user.zname"), /user\.zname/i, (l) => assert.ok(!l.includes("VALUEXYZ")));
  await check("core.hooksPath", () => gitIn(repo, "config", "core.hooksPath", "hooks2"), () => gitIn(repo, "config", "--unset", "core.hooksPath"), /hooks directory changed/);
  await check("a hook file", () => fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }), () => fs.rmSync(path.join(gitDir, "hooks", "pre-commit")), /hooks: added pre-commit/);
  await check("info/attributes", () => fs.writeFileSync(path.join(gitDir, "info", "attributes"), "a.txt filter=x\n"), () => fs.rmSync(path.join(gitDir, "info", "attributes")), /info\/attributes/);
  await check("url.<userinfo>.insteadOf: the userinfo is masked", () => gitIn(repo, "config", "url.https://u:SECRETPW@h/.insteadOf", "x"), () => gitIn(repo, "config", "--unset", "url.https://u:SECRETPW@h/.insteadOf"), /\*\*\*/, (l) => assert.ok(!l.includes("SECRETPW")));
  await check("credential.<userinfo>.helper: the userinfo is masked", () => gitIn(repo, "config", "credential.https://u:TOKX9@h.helper", "store"), () => gitIn(repo, "config", "--unset", "credential.https://u:TOKX9@h.helper"), /\*\*\*/, (l) => assert.ok(!l.includes("TOKX9") && !l.includes("store")));
  const subGit = path.join(gitDir, "modules", "sub");
  await check("a config key in a submodule's git dir", () => gitIn(path.join(repo, "sub"), "config", "user.subkey", "V"), () => gitIn(path.join(repo, "sub"), "config", "--unset", "user.subkey"), /sub: .*user\.subkey/i);
  const subDotGit = path.join(repo, "sub", ".git");
  const orig = fs.readFileSync(subDotGit, "utf8");
  await check("a submodule .git file re-pointed", () => fs.writeFileSync(subDotGit, `gitdir: ${path.join(src, ".git")}\n`), () => fs.writeFileSync(subDotGit, orig), /sub/, () => assert.ok(fs.existsSync(subGit)));
  const marker = path.join(base, "MARKER-filter");
  await check("a planted clean filter with an attribute and a touched tracked file: git is not run, the marker stays absent", () => {
    gitIn(repo, "config", "filter.x.clean", `touch ${marker}`);
    fs.writeFileSync(path.join(gitDir, "info", "attributes"), "a.txt filter=x\n");
    w("a.txt", "touched for the filter\n");
  }, () => {
    gitIn(repo, "config", "--unset", "filter.x.clean");
    fs.rmSync(path.join(gitDir, "info", "attributes"));
  }, /filter\.x\.clean/, () => assert.equal(fs.existsSync(marker), false));
});

test("a planted core.fsmonitor program is not run by the start or the end picture", { skip }, async () => {
  const r = path.join(base, "fsm");
  fs.mkdirSync(r);
  gitIn(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "f.txt"), "f\n");
  gitIn(r, "add", ".");
  gitIn(r, "commit", "-q", "-m", "i");
  const marker = path.join(base, "MARKER-fsm");
  const hook = path.join(base, "fsm.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  gitIn(r, "config", "core.fsmonitor", hook);
  try {
    const start = await pic(r);
    fs.writeFileSync(path.join(r, "f.txt"), "f2\n");
    assert.match(joined(await lines(start, spawnGit, r)), /tracked files changed.*f\.txt/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    gitIn(r, "config", "--unset", "core.fsmonitor");
  }
});

test("a reftable repository sees a commit (skipped when this git has no reftable)", async (t) => {
  const r = path.join(base, "rt");
  fs.mkdirSync(r);
  try {
    gitIn(r, "init", "-q", "-b", "main", "--ref-format=reftable");
  } catch {
    t.skip("git without reftable");
    return;
  }
  fs.writeFileSync(path.join(r, "f.txt"), "f\n");
  gitIn(r, "add", ".");
  gitIn(r, "commit", "-q", "-m", "i");
  const start = await pic(r);
  assert.notEqual(start, "unreadable");
  gitIn(r, "commit", "-q", "--allow-empty", "-m", "two");
  assert.match(joined(await lines(start, spawnGit, r)), /HEAD [0-9a-f]{8} -> [0-9a-f]{8}/);
});

test("exceptions are reported, not swallowed: a throwing git runner, a malformed picture", async () => {
  const boom: GitRunner = () => Promise.reject(new Error("git exploded"));
  assert.equal(await pic(repo, boom), "unreadable");
  const ok = await pic();
  assert.equal(await takeReadonlyState(repo, home, boom, ok), "unreadable");
  assert.deepEqual(diffReadonlyState(ok, "unreadable"), [END_UNREADABLE]);
  assert.deepEqual(diffReadonlyState({} as unknown as Picture, {} as unknown as Picture), [COMPARE_FAILED]);
});

test("a 13-path change shows 12 items and a count; a control character in a path is stripped; the lstat fallback past the cap gives no false line", { skip }, async (t) => {
  const r = path.join(base, "big");
  fs.mkdirSync(r);
  gitIn(r, "init", "-q", "-b", "main");
  const ctrl = "c\u0001d.txt";
  const names = [ctrl, ...Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`), ...Array.from({ length: 2001 }, (_, i) => `m${String(i).padStart(4, "0")}.txt`), "zzz.txt"];
  for (const n of names) fs.writeFileSync(path.join(r, n), "x\n");
  gitIn(r, "add", ".");
  gitIn(r, "commit", "-q", "-m", "i");
  await t.test("12 items and a count, the control character stripped", async () => {
    const start = await pic(r);
    for (const n of names.slice(0, 13)) fs.writeFileSync(path.join(r, n), "y\n");
    const l = (await lines(start, spawnGit, r)).find((x) => x.startsWith("tracked files changed")) ?? "";
    assert.match(l, /\(\+1 more\)$/);
    assert.ok(l.includes("c?d.txt") && !l.includes("\u0001"), l);
    assert.equal(l.split(", ").length, 12);
    for (const n of names.slice(0, 13)) fs.writeFileSync(path.join(r, n), "x\n");
  });
  await t.test("a path hashed in one picture and not in the other compares by lstat; two pictures past the cap compare equal", async () => {
    fs.writeFileSync(path.join(r, "zzz.txt"), "dirty\n");
    const start = await pic(r);
    for (const n of names.filter((x) => x.startsWith("m"))) fs.writeFileSync(path.join(r, n), "dirty\n");
    const l = (await lines(start, spawnGit, r)).find((x) => x.startsWith("tracked files changed")) ?? "";
    assert.match(l, /\(\+1989 more\)$/, "zzz.txt is not among the 2001 changed paths");
    const past = await pic(r);
    assert.deepEqual(await lines(past, spawnGit, r), []);
  });
});
