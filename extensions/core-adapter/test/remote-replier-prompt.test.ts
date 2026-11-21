// The close-flow replier hands the notice to `remote notice` and returns at once: it spawns once and never waits for the parent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteReplier } from "../session.ts";
import type { Spawner } from "../spawn.ts";

const base = { python: "/py", pkgRoot: "/pkg", agentDir: "/nonexistent-agent-dir", cwd: "/tmp", env: {} };

test("closed and refused notices return after one spawn, whatever stdout and stderr say", async () => {
  const calls: string[][] = [];
  const spawner: Spawner = async (_c, args) => {
    calls.push(args);
    return { code: 0, stdout: '{"ok":true,"kind":"closed","seq":4}\n', stderr: "notice 4 queued; the parent has not confirmed it yet\n", timedOut: false };
  };
  const reply = remoteReplier({ ...base, spawner });
  const t0 = Date.now();
  await reply("closed");
  await reply("refused", "not the parent");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(-3), ["remote", "notice", "closed"]);
  assert.equal(calls[1].includes("refused"), true);
});

test("a failing notice still throws the JSON error as before", async () => {
  const spawner: Spawner = async () => ({ code: 1, stdout: '{"error":"no hc terminal"}\n', stderr: "", timedOut: false });
  await assert.rejects(remoteReplier({ ...base, spawner })("closed"), /closed notice failed: no hc terminal/);
});
