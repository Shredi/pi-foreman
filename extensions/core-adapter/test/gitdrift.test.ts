// Foreman git hygiene (T1): env entries, config/hooks snapshot, drift ask. Temp dirs only
// (fs.mkdtempSync under os.tmpdir(), removed on that exact path); no git process runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitDriftWatch, diffGitSnapshots, locateRepo, parseGitConfig, patchForemanGitEnv, takeGitSnapshot } from "../gitdrift.ts";

function tempRepo(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-drift-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n[user]\n\tname = t\n");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  fs.mkdirSync(path.join(dir, "sub"));
  return dir;
}

const HOME = os.tmpdir();

test("foreman env: fsmonitor off and ext transport never, existing entries kept, idempotent", () => {
  const env: Record<string, string | undefined> = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" };
  patchForemanGitEnv(env);
  patchForemanGitEnv(env);
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2], ["user.name", "core.fsmonitor", "false", "protocol.ext.allow", "never"]);
});

test("config reader: sections, subsections, bare keys, comments", () => {
  assert.deepEqual(parseGitConfig('# c\n[core]\n\tfsmonitor = x ; y\n[url "ext::sh -c x"]\n\tinsteadOf = https://a\n[Remote.Origin]\n\tPushUrl\n'), [
    ["core.fsmonitor", "x ; y"],
    ["url.ext::sh -c x.insteadof", "https://a"],
    ["remote.origin.pushurl", "true"],
  ]);
});

test("no change -> no drift; a planted key and hook are named, values never", (t) => {
  const dir = tempRepo(t);
  assert.equal(locateRepo(path.join(dir, "sub"))?.top, dir);
  const before = takeGitSnapshot(path.join(dir, "sub"), HOME);
  assert.deepEqual(diffGitSnapshots(before, takeGitSnapshot(dir, HOME)), []);
  fs.appendFileSync(path.join(dir, ".git", "config"), "[core]\n\tfsmonitor = /tmp/SECRET-PROGRAM\n");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nevil\n");
  const lines = diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
  assert.deepEqual(lines, ["git:config: added core.fsmonitor", "hooks: added post-checkout; changed pre-commit"]);
  assert.doesNotMatch(lines.join("\n"), /SECRET/);
});

test("in-repo include files, linked worktree config and its .git file are snapshotted", (t) => {
  const dir = tempRepo(t);
  const wt = path.join(dir, "wt");
  fs.mkdirSync(path.join(dir, ".git", "worktrees", "w1"), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(dir, ".git", "worktrees", "w1")}\n`);
  fs.writeFileSync(path.join(dir, ".git", "worktrees", "w1", "gitdir"), path.join(wt, ".git") + "\n");
  fs.writeFileSync(path.join(dir, ".git", "worktrees", "w1", "commondir"), "../..\n");
  fs.appendFileSync(path.join(dir, ".git", "config"), "[include]\n\tpath = extra.cfg\n");
  fs.writeFileSync(path.join(dir, ".git", "extra.cfg"), "[x]\n\ty = 1\n");
  assert.equal(locateRepo(wt)?.commonDir, path.join(dir, ".git"));
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(path.join(dir, ".git", "extra.cfg"), "[x]\n\ty = 1\n[diff]\n\texternal = z\n");
  fs.writeFileSync(path.join(dir, ".git", "worktrees", "w1", "config.worktree"), "[core]\n\tpager = z\n");
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere\n");
  assert.deepEqual(diffGitSnapshots(before, takeGitSnapshot(dir, HOME)), [
    "git:extra.cfg: added diff.external",
    "git:worktrees/w1/config.worktree: new file (keys core.pager)",
    "worktree-git-file:w1: content changed",
  ]);
});

test("gate: no snapshot -> no check; drift asks in rpc, denies without UI, re-snapshots on approve", async (t) => {
  const dir = tempRepo(t);
  const w = new GitDriftWatch();
  const traces: Record<string, unknown>[] = [];
  const trace = (r: Record<string, unknown>) => void traces.push(r);
  fs.appendFileSync(path.join(dir, ".git", "config"), "[a]\n\tb = 1\n");
  assert.equal(await w.gate(dir, HOME, "x", { mode: "print", hasUI: false }, trace), undefined);
  w.snapshot(dir, HOME);
  fs.appendFileSync(path.join(dir, ".git", "config"), "[protocol \"ext\"]\n\tallow = always\n");
  const printed = await w.gate(dir, HOME, "this git command", { mode: "print", hasUI: false }, trace);
  assert.match(printed?.reason ?? "", /no UI.*\n.*added protocol\.ext\.allow/s);
  let asked = "";
  const denied = await w.gate(dir, HOME, "this git command", { mode: "rpc", hasUI: true, confirm: async (_t, m) => ((asked = m), false) }, trace);
  assert.match(denied?.reason ?? "", /^Denied by the user/);
  assert.match(asked, /added protocol\.ext\.allow/);
  assert.doesNotMatch(asked, /always/);
  assert.equal(await w.gate(dir, HOME, "this git command", { mode: "tui", hasUI: true, confirm: async () => true }, trace, "call-1"), undefined);
  assert.equal(await w.gate(dir, HOME, "x", { mode: "print", hasUI: false }, trace), undefined, "approved state is the new baseline");
  // The foreman's own git call: its changes become the baseline after the call.
  fs.appendFileSync(path.join(dir, ".git", "config"), "[branch \"f\"]\n\tremote = origin\n");
  w.after(dir, HOME, "call-1");
  assert.equal(await w.gate(dir, HOME, "x", { mode: "print", hasUI: false }, trace), undefined);
  assert.deepEqual(traces, [
    { event: "git_config_drift", decision: "no-ui" },
    { event: "git_config_drift", decision: "denied" },
    { event: "git_config_drift", decision: "approved" },
  ]);
});
