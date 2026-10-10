import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { bashCandidates, ManifestRecorder, manifestOwner, recordArgs, recordEntries, writeCandidates } from "../manifest.ts";

const c = { cwd: "/w/repo", stateDir: "/a/pi-foreman/state", platform: "linux" };

test("manifest: git worktree add variants (-b/-B, -C, cd chains, relative paths, --detach, DWIM branch)", () => {
  assert.deepEqual(bashCandidates("git worktree add -b feat ../repo.worktrees/feat", c), [{ kind: "worktree", path: "/w/repo.worktrees/feat", branch: "feat" }]);
  assert.deepEqual(bashCandidates("git worktree add -f -B fix/x ../wt origin/base", c), [{ kind: "worktree", path: "/w/wt", branch: "fix/x" }]);
  assert.deepEqual(bashCandidates("git -C sub worktree add --detach ../wt HEAD", c), [{ kind: "worktree", path: "/w/repo/wt" }]);
  assert.deepEqual(bashCandidates("cd /x && git worktree add ../wt && echo ok", c), [{ kind: "worktree", path: "/wt", branch: "wt" }]);
  assert.deepEqual(bashCandidates("cd sub; git -C .. worktree add -bfeat --reason r wt2 HEAD~1", c), [{ kind: "worktree", path: "/w/repo/wt2", branch: "feat" }]);
  assert.deepEqual(bashCandidates("git worktree add existing-branch-wt main2", c), [{ kind: "worktree", path: "/w/repo/existing-branch-wt" }]);
  for (const skip of ["git worktree list", "cd ~/x && git worktree add wt", "git worktree add $(pwd)/wt", "cd && git worktree add wt", "echo git worktree add wt"]) assert.deepEqual(bashCandidates(skip, c), [], skip);
});

test("manifest: mkdir under scratch records the topic dir; files directly in .workflow/scratch are ignored", () => {
  assert.deepEqual(bashCandidates("mkdir -p .workflow/scratch/topic/deeper/x", c), [{ kind: "scratch", path: "/w/repo/.workflow/scratch/topic" }]);
  assert.deepEqual(bashCandidates("mkdir /a/pi-foreman/state/scratch/sid1/sub", c), [{ kind: "scratch", path: "/a/pi-foreman/state/scratch/sid1" }]);
  assert.deepEqual(bashCandidates("mkdir -p .workflow/scratch && mkdir src/x", c), []);
  assert.deepEqual(writeCandidates(".workflow/scratch/topic/notes.md", c), [{ kind: "scratch", path: "/w/repo/.workflow/scratch/topic" }]);
  assert.deepEqual(writeCandidates(".workflow/scratch/plan.md", c), []);
  assert.deepEqual(writeCandidates("src/a.ts", c), []);
});

test("manifest: win32 paths resolve with backslashes and drive letters; C:foo is skipped", () => {
  const w = { cwd: "C:\\w\\repo", stateDir: "C:\\a\\state", platform: "win32" };
  assert.deepEqual(bashCandidates("git worktree add -b feat ../repo.worktrees/feat", w), [{ kind: "worktree", path: "C:\\w\\repo.worktrees\\feat", branch: "feat" }]);
  assert.deepEqual(writeCandidates(".Workflow\\Scratch\\t\\n.md", w), [{ kind: "scratch", path: "C:\\w\\repo\\.Workflow\\Scratch\\t" }]);
  assert.deepEqual(bashCandidates("git worktree add C:wt", w), []);
});

test("manifest: scratch is recorded only when absent at tool_call; an error result records nothing", () => {
  const existing = new Set<string>(["/w/repo/.workflow/scratch/old"]);
  const r = new ManifestRecorder((p) => existing.has(p));
  r.onToolCall("1", "bash", { command: "mkdir -p .workflow/scratch/old/x .workflow/scratch/new && git worktree add -b b ../wt" }, c);
  existing.add("/w/repo/.workflow/scratch/new");
  existing.add("/w/wt");
  assert.deepEqual(r.onToolResult("1", false), [{ kind: "scratch", path: "/w/repo/.workflow/scratch/new" }, { kind: "worktree", path: "/w/wt", branch: "b" }]);
  r.onToolCall("2", "write", { path: ".workflow/scratch/t2/a.md" }, c);
  existing.add("/w/repo/.workflow/scratch/t2");
  assert.deepEqual(r.onToolResult("2", true), []);
  assert.deepEqual(r.onToolResult("2", false), [], "consumed");
});

test("manifest: a child records into the foreman's manifest with its launch id as owner", async () => {
  assert.deepEqual(manifestOwner({ id: "top", isChild: false }, {}), { session: "top", owner: "top" });
  assert.deepEqual(manifestOwner({ id: "kid", isChild: true, foremanSession: "fm", launchId: "L1" }, {}), { session: "fm", owner: "L1" });
  assert.deepEqual(manifestOwner({ id: "kid", isChild: true }, { PI_SUBAGENT_PARENT_SESSION: "env-fm" }), { session: "env-fm", owner: "kid" });
  const calls: string[][] = [];
  await recordEntries([{ kind: "worktree", path: path.posix.join("/w", "wt"), branch: "b" }, { kind: "scratch", path: "/s" }], { session: "fm", owner: "L1", stateDir: "/st" }, async (a) => {
    calls.push(a);
    throw new Error("no python");
  });
  assert.deepEqual(calls[0], recordArgs({ kind: "worktree", path: "/w/wt", branch: "b" }, { session: "fm", owner: "L1", stateDir: "/st" }));
  assert.deepEqual(calls[0], ["record", "--kind", "worktree", "--path", "/w/wt", "--branch", "b", "--owner", "L1", "--session", "fm", "--state", "/st"]);
  assert.equal(calls.length, 2, "a failing record never stops the next");
});
