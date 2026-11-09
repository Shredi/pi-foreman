import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const savedChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
after(() => {
  if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = savedChild;
});

const root = path.join(os.tmpdir(), "pf-session-npm-pending");

function deps(protectedRoots: SessionDeps["protectedRoots"]): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: path.join(root, "agent"),
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    confirm: async () => true,
    protectedRoots,
    spawned,
  };
}

test("session open --worktree is refused while the npm root is still resolving", async () => {
  const d = deps({ npmRootPending: true });
  const r = await runSessionCommand(d, "open demo b.md --worktree");
  assert.equal(r.ok, false);
  assert.match(r.text, /root_unresolved.*still resolving/);
  assert.equal(d.spawned.length, 0);
});

test("session open --worktree is not refused once the npm root resolved or failed", async () => {
  const d = deps({ npmRootPending: false });
  const r = await runSessionCommand(d, "open demo b.md --worktree --dry-run");
  assert.doesNotMatch(r.text, /root_unresolved/);
});
