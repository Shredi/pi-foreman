// r75 item 5 (owner OK 2026-10-29): branch.<b>.merge = refs/heads/<any name> is routine while branch.<b>.remote names a remote whose url is
// present and unchanged in both snapshots (`worktree add -b X origin/main` tracks main). Hooks, aliases and the other config keys still count.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffGitSnapshots, takeGitSnapshot } from "../gitdrift.ts";

const HOME = os.tmpdir();

function diffAfter(t: { after(fn: () => void): void }, add: string, mutate?: (base: string) => string): string[] {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-drift5-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  const cfg = path.join(dir, ".git", "config");
  const base = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://example.invalid/r.git\n";
  fs.writeFileSync(cfg, base);
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(cfg, mutate ? mutate(base) : base + add);
  return diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
}

test("worktree add -b X origin/main: branch.X.remote = origin and merge = refs/heads/main is routine", (t) => {
  assert.deepEqual(diffAfter(t, '[branch "X"]\n\tremote = origin\n\tmerge = refs/heads/main\n'), []);
  assert.deepEqual(diffAfter(t, '[branch "feat/y"]\n\tremote = origin\n\tmerge = refs/heads/some/other-name.v2\n'), []);
});

test("a changed merge value to another refs/heads name is routine too", (t) => {
  const start = '[branch "X"]\n\tremote = origin\n\tmerge = refs/heads/X\n';
  const diff = diffAfter(t, "", (b) => b + start.replace("refs/heads/X", "refs/heads/main"));
  assert.deepEqual(diff, []);
});

test("merge that is not refs/heads/<name> still asks", (t) => {
  for (const v of ["refs/tags/v1", "refs/remotes/origin/main", "refs/heads/", "main", "refs/heads/a b"]) {
    assert.deepEqual(diffAfter(t, `[branch "X"]\n\tremote = origin\n\tmerge = ${v}\n`), ["git:config: added branch.X.merge"], v);
  }
});

test("merge asks when branch.<b>.remote is missing, a URL or path, an unknown name, or its url changed", (t) => {
  assert.deepEqual(diffAfter(t, '[branch "X"]\n\tmerge = refs/heads/main\n'), ["git:config: added branch.X.merge"]);
  assert.deepEqual(diffAfter(t, '[branch "X"]\n\tremote = ../evil\n\tmerge = refs/heads/main\n'), ["git:config: added branch.X.remote, branch.X.merge"]);
  assert.deepEqual(diffAfter(t, '[branch "X"]\n\tremote = nowhere\n\tmerge = refs/heads/main\n'), ["git:config: added branch.X.remote, branch.X.merge"]);
  const changed = diffAfter(t, "", (b) => b.replace("r.git", "x.git") + '[branch "X"]\n\tremote = origin\n\tmerge = refs/heads/main\n');
  assert.deepEqual(changed, ["git:config: added branch.X.remote, branch.X.merge; changed remote.origin.url"]);
});

test("a routine tracking pair does not hide hooks, alias, sshCommand, hooksPath, fsmonitor, filter, credential, include or insteadOf", (t) => {
  const track = '[branch "X"]\n\tremote = origin\n\tmerge = refs/heads/main\n';
  const risky: Array<[string, string]> = [
    ["[alias]\n\tpush = !sh -c x\n", "alias.push"],
    ["[core]\n\tsshCommand = x\n", "core.sshcommand"],
    ["[core]\n\thooksPath = /x\n", "core.hookspath"],
    ["[core]\n\tfsmonitor = x\n", "core.fsmonitor"],
    ['[filter "f"]\n\tclean = x\n', "filter.f.clean"],
    ['[credential "https://h"]\n\thelper = x\n', "credential.https://h.helper"],
    ["[include]\n\tpath = /x\n", "include.path"],
    ['[url "ext::sh -c x"]\n\tinsteadOf = https://a\n', "url.ext::sh -c x.insteadof"],
  ];
  for (const [text, key] of risky) {
    // core.hooksPath also reports the hooks directory; both lines ask
    const extra = key === "core.hookspath" ? ["hooks directory changed (core.hooksPath)"] : [];
    assert.deepEqual(diffAfter(t, track + text), [`git:config: added ${key}`, ...extra], key);
  }
});
