import { test } from "node:test";
import assert from "node:assert/strict";
import { runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const ranks = [{ match: "claude-opus-*", tier: 1 }, { match: "claude-sonnet-*", tier: 2 }];
const config = { providers: { "claude-bridge": { ranks } } };

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: "/tmp/pf-rank-unknown2-agent",
    cwd: "/tmp",
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    spawned,
    ...over,
  };
}

test("session open: unknown own model with ranks refuses even without --model or a mapping", async () => {
  const d = deps({ config });
  const r = await runSessionCommand(d, "open demo b.md");
  assert.equal(r.ok, false);
  assert.match(r.text, /^session open refused \[session_rank\].*own model unknown/);
  assert.equal(d.spawned.length, 0);
});

test("session open: unknown own model without ranks and no --model still opens", async () => {
  const d = deps({ config: {} });
  const r = await runSessionCommand(d, "open demo b.md --dry-run");
  assert.equal(r.ok, true);
  assert.equal(d.spawned.length, 1);
});
