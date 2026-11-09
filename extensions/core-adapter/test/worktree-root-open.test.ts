// sessionOpen's worktree refusals (resolver error, reserved label), the launch-wait worktree line under a custom absolute root, and the
// glob compilation of worktreeroot.ts pinned to permoverlay.ts wildcardRegExp. Temp trees only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { diffGitSnapshots, takeGitSnapshot } from "../gitdrift.ts";
import { launchWaitText, worktreeOfRun } from "../launchwait.ts";
import { wildcardRegExp } from "../permoverlay.ts";
import { runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { globRegExp } from "../worktreeroot.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "POSIX path fixtures" : false;
const tmp = fs.realpathSync(mkTestTmp("pf-wt-open-"));
process.on("exit", () => rmTestTmp(tmp));
const repo = path.join(tmp, "work", "repo");
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
fs.writeFileSync(path.join(tmp, "b.md"), "# t\n");

function deps(config: SessionDeps["config"]): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: path.join(tmp, "agent"),
    cwd: repo,
    piSessionId: "s1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    confirm: async () => true,
    config,
    spawned,
  };
}

test("sessionOpen --worktree: reserved label `worktrees` is refused before anything is spawned", { skip }, async () => {
  const d = deps({});
  const r = await runSessionCommand(d, `open worktrees ${path.join(tmp, "b.md")} --worktree`);
  assert.equal(r.ok, false);
  assert.match(r.text, /\[label_reserved\]/);
  assert.equal(d.spawned.length, 0);
});

test("sessionOpen --worktree: a refused close.worktreeDir is a resolver error, nothing spawned", { skip }, async () => {
  const d = deps({ close: { worktreeDir: path.join(tmp, "plain-no-placeholder") } });
  const r = await runSessionCommand(d, `open demo ${path.join(tmp, "b.md")} --worktree`);
  assert.equal(r.ok, false);
  assert.match(r.text, /session open refused \[no_repo_placeholder\]/);
  assert.equal(d.spawned.length, 0);
});

test("sessionOpen --worktree: a valid custom absolute root passes the check and spawns", { skip }, async () => {
  const d = deps({ close: { worktreeDir: path.join(tmp, "elsewhere", "trees", "<repo>") } });
  const r = await runSessionCommand(d, `open demo ${path.join(tmp, "b.md")} --worktree`);
  assert.equal(r.ok, true, r.text);
  assert.equal(d.spawned.length, 1);
});

test("launch-wait worktree line names a worktree under a custom absolute root", { skip }, () => {
  const wt = path.join(tmp, "elsewhere", "trees", "repo", "round");
  const dir = path.join(tmp, "async");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ steps: [{ worktreePath: wt, branch: "round/x" }] }));
  assert.deepEqual(worktreeOfRun(dir), { path: wt, branch: "round/x" });
  const text = launchWaitText({ outcome: "done", runId: "r1", role: "builder", ms: 1000, maxSeconds: 60, asyncDir: dir });
  assert.ok(text.includes(`worktree: ${wt} (branch round/x)`), text);
});

test("a changed remote.origin.url (what a submodule sync would write) is reported as drift, an unchanged one is not", { skip }, () => {
  const dir = path.join(tmp, "drift");
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  const cfg = path.join(dir, ".git", "config");
  const cfgText = (u: string) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${u}\n`;
  fs.writeFileSync(cfg, cfgText("https://example.invalid/a.git"));
  const before = takeGitSnapshot(dir, tmp);
  assert.deepEqual(diffGitSnapshots(before, takeGitSnapshot(dir, tmp)), []);
  fs.writeFileSync(cfg, cfgText("https://example.invalid/b.git"));
  assert.ok(diffGitSnapshots(before, takeGitSnapshot(dir, tmp)).length > 0);
});

test("globRegExp matches like permoverlay wildcardRegExp", () => {
  const patterns = ["/a/trees/*/*", "/a/b?/x", "/a/*.wt/*", "/a/trees/repo/*"];
  const samples = ["/a/trees/r/round", "/a/trees/r/round/deep/f", "/a/bx/x", "/a/by/x/y", "/a/r.wt/round", "/a/trees/repo/x", "/a/other"];
  for (const p of patterns) {
    for (const s of samples) {
      const a = globRegExp(p, false).test(s);
      const b = wildcardRegExp(p, { home: "/home/u", ignoreCase: false, foldSeparators: false }).test(s);
      assert.equal(a, b, `${p} vs ${s}`);
    }
  }
});
