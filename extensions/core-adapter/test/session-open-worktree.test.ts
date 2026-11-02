import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_USAGE, WORKTREE_MARK, parseSessionArgs, runSessionCommand, runSessionOpenTool } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const savedChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
after(() => {
  if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = savedChild;
});

const root = path.join(os.tmpdir(), "pf-session-worktree");
const wt = { path: path.join(root, "r.worktrees", "demo"), branch: "round/demo", base: "origin/main", install: "none" };

function deps(over: Partial<SessionDeps> = {}, stdout = "handoff: x"): SessionDeps & { spawned: string[][]; traced: Record<string, unknown>[]; recorded: unknown[] } {
  const spawned: string[][] = [];
  const traced: Record<string, unknown>[] = [];
  const recorded: unknown[] = [];
  return {
    isChild: false,
    env: {},
    agentDir: path.join(root, "agent"),
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout, stderr: "", timedOut: false }),
    send: async () => "sent",
    trace: (r) => void traced.push(r),
    recordWorktree: async (e) => void recorded.push(e),
    spawned,
    traced,
    recorded,
    ...over,
  };
}

test("session open: --worktree and --base parse; absent flags add no fields", () => {
  assert.deepEqual(parseSessionArgs("open demo b.md --worktree --base origin/dev"), { sub: "open", label: "demo", brief: "b.md", planFirst: false, focus: false, dryRun: false, worktree: true, base: "origin/dev" });
  const plain = parseSessionArgs("open demo b.md");
  assert.ok(!("worktree" in plain) && !("base" in plain));
  assert.ok("error" in parseSessionArgs("open demo b.md --worktree --base"));
  assert.match(String((parseSessionArgs("open demo b.md --base main") as { error: string }).error), /--base needs --worktree/);
  assert.match(String((parseSessionArgs("open demo b.md --worktree --machine a") as { error: string }).error), /--machine/);
  assert.match(SESSION_USAGE, /--worktree \[--base REF\]/);
});

test("session open: the flags are forwarded to the CLI", async () => {
  const d = deps();
  assert.equal((await runSessionCommand(d, "open demo b.md --worktree --base v1 --dry-run")).ok, true);
  const a = d.spawned[0];
  assert.ok(a.includes("--worktree"));
  assert.equal(a[a.indexOf("--base") + 1], "v1");
  const plain = deps();
  await runSessionCommand(plain, "open demo b.md");
  assert.ok(!plain.spawned[0].includes("--worktree") && !plain.spawned[0].includes("--base"));
});

test("foreman_session_open: worktree and base validation", async () => {
  const d = deps();
  assert.equal((await runSessionOpenTool(d, { label: "demo", brief: "b.md", base: "main" })).ok, false);
  assert.equal((await runSessionOpenTool(d, { label: "demo", brief: "b.md", worktree: "yes" })).ok, false);
  assert.equal((await runSessionOpenTool(d, { label: "demo", brief: "b.md", worktree: true, machine: "alpha", cwd: "/x" })).ok, false);
  assert.equal(d.spawned.length, 0);
  assert.equal((await runSessionOpenTool(d, { label: "demo", brief: "b.md", worktree: true, base: "v1" })).ok, true);
  assert.ok(d.spawned[0].includes("--worktree") && d.spawned[0].includes("v1"));
});

test("worktree open: records the worktree and traces session_worktree after a successful open", async () => {
  const d = deps({}, `handoff: x\n${WORKTREE_MARK}${JSON.stringify(wt)}`);
  assert.equal((await runSessionCommand(d, "open demo b.md --worktree")).ok, true);
  assert.deepEqual(d.recorded, [{ kind: "worktree", path: wt.path, branch: wt.branch }]);
  assert.deepEqual(d.traced, [{ event: "session_worktree", label: "demo", path: wt.path, branch: wt.branch, base: wt.base, install: wt.install }]);
});

test("worktree open: no trace for a dry run, a failed open or an open without the worktree line", async () => {
  const dry = deps({}, `${WORKTREE_MARK}${JSON.stringify(wt)}`);
  await runSessionCommand(dry, "open demo b.md --worktree --dry-run");
  const failed = deps({ spawner: async () => ({ code: 1, stdout: `${WORKTREE_MARK}${JSON.stringify(wt)}`, stderr: "refused", timedOut: false }) });
  assert.equal((await runSessionCommand(failed, "open demo b.md --worktree")).ok, false);
  const none = deps();
  await runSessionCommand(none, "open demo b.md --worktree");
  for (const d of [dry, failed, none]) assert.deepEqual([d.traced, d.recorded], [[], []]);
});
