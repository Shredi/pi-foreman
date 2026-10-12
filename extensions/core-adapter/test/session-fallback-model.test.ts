import { test } from "node:test";
import assert from "node:assert/strict";
import { runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: "/tmp/pf-fallback-model-agent",
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

test("session open: the opener's own model is shown but not passed as --model (no PI_FOREMAN_SESSION_MODEL in the child)", async () => {
  const own = "p/own-model";
  const d = deps({ model: own });
  const r = await runSessionCommand(d, "open demo b.md --dry-run");
  assert.match(r.text, /^session model: p\/own-model\n/);
  assert.equal(d.spawned[0].includes("--model"), false);
  assert.deepEqual(d.spawned[0].slice(-3), ["--own-model", own, "--dry-run"]);
});

test("session open: an explicit --model is still passed", async () => {
  const d = deps({ model: "p/own-model" });
  await runSessionCommand(d, "open demo b.md --model p/other --dry-run");
  assert.deepEqual(d.spawned[0].slice(-3), ["--model", "p/other", "--dry-run"]);
});
