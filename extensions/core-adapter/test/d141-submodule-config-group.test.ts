// D141: submodule git-dir config changes that touch only quiet keys are one grouped line; any other key keeps its file line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ITEMS, diffGitSnapshots, takeGitSnapshot } from "../gitdrift.ts";

const HOME = os.tmpdir();
const BASE = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote \"origin\"]\n\turl = /src\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";
const N = 600;
const SEEN = 500; // the snapshot reads at most 500 submodule git dirs

function repoWithModules(t: { after(fn: () => void): void }, n: number): { dir: string; cfg: (i: number) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-d141-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n");
  const cfg = (i: number): string => path.join(dir, ".git", "modules", `m${i}`, "config");
  for (let i = 0; i < n; i++) {
    fs.mkdirSync(path.dirname(cfg(i)), { recursive: true });
    fs.writeFileSync(cfg(i), BASE);
  }
  return { dir, cfg };
}
const quietChange = "[core]\n\tworktree = ../../../m\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = true\n\tprecomposeunicode = true\n";

test("600 submodule configs with quiet-key changes: one capped line", (t) => {
  const { dir, cfg } = repoWithModules(t, N);
  const before = takeGitSnapshot(dir, HOME);
  for (let i = 0; i < N; i++) fs.appendFileSync(cfg(i), quietChange);
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.equal(lines.length, 1, JSON.stringify(lines).slice(0, 300));
  assert.match(lines[0], new RegExp(`^submodule configs: ${SEEN} changed \\(.*; \\+${SEEN - MAX_ITEMS} more\\)$`));
});

test("one of the 600 also adds filter.x.clean: that file is named beside the grouped line", (t) => {
  const { dir, cfg } = repoWithModules(t, N);
  const before = takeGitSnapshot(dir, HOME);
  for (let i = 0; i < N; i++) fs.appendFileSync(cfg(i), quietChange);
  fs.appendFileSync(cfg(1), '[filter "x"]\n\tclean = sh -c evil\n');
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.ok(lines.some((l) => l.startsWith("git:modules/m1/config: added") && l.endsWith("filter.x.clean")), JSON.stringify(lines).slice(0, 300));
  assert.ok(lines.some((l) => l.startsWith(`submodule configs: ${SEEN - 1} changed`)), JSON.stringify(lines).slice(0, 300));
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.find((l) => l.startsWith("submodule configs"))!, /\bm1[;)]/);
});

test("core.hooksPath and core.fsmonitor in a submodule config are shown by name; an unknown non-exec key is quiet", (t) => {
  const { dir, cfg } = repoWithModules(t, 3);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(cfg(0), "[core]\n\thooksPath = /x\n");
  fs.appendFileSync(cfg(1), "[core]\n\tfsmonitor = /x\n");
  fs.appendFileSync(cfg(2), "[brandnew]\n\tkey = 1\n");
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.deepEqual(lines, ["git:modules/m0/config: added core.hookspath", "git:modules/m1/config: added core.fsmonitor"]);
});

test("a changed remote url is quiet; a quiet and a dangerous key in one file keeps the file line", (t) => {
  const { dir, cfg } = repoWithModules(t, 2);
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(cfg(0), BASE.replace("/src", "/elsewhere"));
  fs.appendFileSync(cfg(1), "[core]\n\tbare = false\n\tsshCommand = evil\n");
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.deepEqual(lines, ["git:modules/m1/config: added core.bare, core.sshcommand", "submodule configs: 1 changed (m0)"]);
});

test("a new submodule config with only clone keys is grouped; a removed one keeps its line", (t) => {
  const { dir, cfg } = repoWithModules(t, 2);
  const before = takeGitSnapshot(dir, HOME);
  fs.rmSync(path.dirname(cfg(0)), { recursive: true });
  fs.mkdirSync(path.dirname(cfg(5)), { recursive: true });
  fs.writeFileSync(cfg(5), BASE + "[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n");
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.deepEqual(lines, ["git:modules/m0/config: removed", "submodule configs: 1 changed (m5)"]);
});

test("a new hook named config inside a submodule git dir keeps its own line", (t) => {
  const { dir } = repoWithModules(t, 1);
  const before = takeGitSnapshot(dir, HOME);
  const hook = path.join(dir, ".git", "modules", "m0", "hooks", "config");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho hi\n");
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.ok(lines.length >= 1 && lines.every((l) => !l.startsWith("submodule configs")), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes("git:modules/m0/hooks/config")), JSON.stringify(lines));
});
