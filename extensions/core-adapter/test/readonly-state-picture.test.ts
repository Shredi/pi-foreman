// Run-end state hint (plan readonly-target v11, A/B): the picture of a checkout and its comparison, on one real fixture repo with one submodule.
import "./_hermetic-env.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitIn } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { compareRunEnd, diffReadonlyState, launchRunCwds, noticeText, readonlyRoles, spawnGit, takeReadonlyState, takeStartEntry, type GitRunner } from "../readonlystate.ts";

let base = "";
let repo = "";
const home = os.homedir();
const w = (rel: string, text: string): void => fs.writeFileSync(path.join(repo, rel), text);
const counting = (): { run: GitRunner; n: () => number } => {
  let n = 0;
  return { run: (cwd, args, sig) => (n++, spawnGit(cwd, args, sig)), n: () => n };
};
const pic = (g: GitRunner = spawnGit) => takeReadonlyState(repo, home, g);
const end = async (start: Awaited<ReturnType<typeof pic>>, g: GitRunner = spawnGit) => takeReadonlyState(repo, home, g, start);

before(() => {
  base = fs.realpathSync(mkTestTmp("pf-ro-state-"));
  const src = path.join(base, "src");
  repo = path.join(base, "repo");
  fs.mkdirSync(src);
  gitIn(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "s.txt"), "s\n");
  gitIn(src, "add", "s.txt");
  gitIn(src, "commit", "-q", "-m", "s");
  fs.mkdirSync(repo);
  gitIn(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  gitIn(repo, "submodule", "add", "-q", src, "sub");
  gitIn(repo, "commit", "-q", "-m", "sub");
});
after(() => rmTestTmp(base));

test("an untouched checkout compares equal; untracked files and .workflow are not pictured", async () => {
  const a = await pic();
  w("untracked.txt", "x\n");
  fs.mkdirSync(path.join(repo, ".workflow"), { recursive: true });
  w(".workflow/n.md", "x\n");
  assert.deepEqual(diffReadonlyState(a, await end(a)), []);
  fs.rmSync(path.join(repo, "untracked.txt"));
});

test("a tracked file edit is named; restoring it compares equal again", async () => {
  const a = await pic();
  w("a.txt", "changed\n");
  const lines = diffReadonlyState(a, await end(a));
  assert.ok(lines.some((l) => l.includes("tracked files changed") && l.includes("a.txt")), lines.join("|"));
  assert.ok(!lines.join("").includes("changed\n"));
  w("a.txt", "a\n");
  assert.deepEqual(diffReadonlyState(a, await end(a)), []);
});

test("staging, a new commit and a branch switch are named", async () => {
  const a = await pic();
  w("b.txt", "b2\n");
  gitIn(repo, "add", "b.txt");
  const staged = diffReadonlyState(a, await end(a));
  assert.ok(staged.some((l) => l.includes("index entries changed") && l.includes("b.txt")), staged.join("|"));
  gitIn(repo, "commit", "-q", "-m", "b2");
  gitIn(repo, "checkout", "-q", "-b", "other");
  const moved = diffReadonlyState(a, await end(a)).join("|");
  assert.match(moved, /HEAD [0-9a-f]{8} -> [0-9a-f]{8}/);
  assert.match(moved, /branch main -> other/);
  gitIn(repo, "checkout", "-q", "main");
  gitIn(repo, "branch", "-q", "-D", "other");
});

test("a submodule edit is named with its path", async () => {
  const a = await pic();
  fs.writeFileSync(path.join(repo, "sub", "s.txt"), "edited\n");
  const lines = diffReadonlyState(a, await end(a));
  assert.ok(lines.some((l) => l.startsWith("sub: ") && l.includes("s.txt")), lines.join("|"));
  gitIn(path.join(repo, "sub"), "checkout", "-q", "--", "s.txt");
  assert.deepEqual(diffReadonlyState(a, await end(a)), []);
});

test("a settings change is named by key, never by value, and no git runs at the end", async () => {
  const a = await pic();
  const c = counting();
  gitIn(repo, "config", "filter.x.clean", "echo SECRETVALUE");
  const b = await end(a, c.run);
  const lines = diffReadonlyState(a, b);
  assert.equal(c.n(), 0);
  assert.ok(lines.some((l) => l.includes("filter.x.clean")), lines.join("|"));
  assert.ok(lines.some((l) => l.includes("files not compared")));
  assert.ok(!lines.join("").includes("SECRETVALUE"));
  gitIn(repo, "config", "--unset", "filter.x.clean");
  assert.deepEqual(diffReadonlyState(a, await end(a)), []);
});

test("URL userinfo is masked up to the last @ before the host", async () => {
  const a = await pic();
  gitIn(repo, "config", "url.https://u:p@x@h/.insteadOf", "zz:");
  const lines = diffReadonlyState(a, await end(a));
  gitIn(repo, "config", "--remove-section", "url.https://u:p@x@h/");
  assert.ok(lines.length > 0);
  assert.ok(!lines.join("|").includes("u:p") && !lines.join("|").includes("x@h"), lines.join("|"));
});

test("a branch tracking key of another branch is not a difference; a hook is", async () => {
  const a = await pic();
  gitIn(repo, "config", "branch.zzz.remote", "origin");
  assert.deepEqual(diffReadonlyState(a, await end(a)), []);
  gitIn(repo, "config", "--unset", "branch.zzz.remote");
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const lines = diffReadonlyState(a, await end(a));
  fs.rmSync(hook);
  assert.ok(lines.some((l) => l.startsWith("hooks: ") && l.includes("pre-commit")), lines.join("|"));
});

test("an unreadable start or end is 'not compared', never a difference", async () => {
  const a = await pic();
  assert.deepEqual(diffReadonlyState("unreadable", a), ["not compared: start unreadable"]);
  assert.deepEqual(diffReadonlyState(a, "unreadable"), ["not compared: end unreadable"]);
  assert.equal(await takeReadonlyState(path.join(base, "nowhere"), home, spawnGit), "unreadable");
});

test("compareRunEnd and noticeText: outcome, names only, nothing blocked", async () => {
  const entry = await takeStartEntry([repo], home, spawnGit);
  assert.equal(entry.kind, "picture");
  if (entry.kind !== "picture") return;
  assert.equal((await compareRunEnd(entry, home, spawnGit)).outcome, "unchanged");
  w("a.txt", "again\n");
  const r = await compareRunEnd(entry, home, spawnGit);
  w("a.txt", "a\n");
  assert.equal(r.outcome, "changed");
  const text = noticeText("reviewer", "abcdef123456", r);
  assert.match(text, /reviewer run abcdef12 ended/);
  assert.match(text, /a\.txt/);
  assert.match(text, /Nothing was blocked or undone/);
  assert.ok(!text.includes("again"));
  assert.deepEqual(await takeStartEntry([], home, spawnGit), { kind: "no tree" });
});

test("launch helpers: read-only roles and the cwds of a launch", () => {
  assert.equal(readonlyRoles(["reviewer", "explorer"]), true);
  assert.equal(readonlyRoles(["reviewer", "builder"]), false);
  assert.equal(readonlyRoles([]), false);
  const cwds = launchRunCwds({ chain: [{ agent: "reviewer" }, { parallel: [{ agent: "explorer", cwd: "x" }] }], cwd: "/p" }, "/s").sort();
  assert.deepEqual(cwds, ["/p", "/p/x"]);
  assert.deepEqual(launchRunCwds({ agent: "reviewer" }, "/s"), ["/s"]);
});
