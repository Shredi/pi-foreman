import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRemotePull } from "../remotepull.ts";
import type { PullHost } from "../remotepull.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";

const files = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[f] = `${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, "utf8")}`;
  }
  return out;
};

test("stop while a pull is in flight: the aborted pull writes no registry, no state and no remote_pull trace", async () => {
  const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pull-stop-")));
  const mirror = path.join(agent, "mirror");
  fs.mkdirSync(mirror, { recursive: true });
  const e: SessionEntry = { label: "demo", child: CHILD, parent: "sess-1", status: "open", opened: "2020-01-01T00:00:00", handoff: mirror, machine: "alpha", originMachine: "Alpha", remoteHandoff: "/home/u/.pi/agent/pi-foreman/handoffs/20261024-120000-demo", handoffName: "20261024-120000-demo", mirror, remote: { platform: "linux" }, returnPath: "pull" };
  writeRegistry(agent, { version: 1, sessions: [e] });
  const before = files(agent);

  let seen: AbortSignal | undefined;
  let started!: () => void;
  const inFlight = new Promise<void>((res) => (started = res));
  const spawner: Spawner = (_cmd, _args, options) =>
    new Promise<SpawnResult>((resolve) => {
      seen = options?.signal;
      started();
      options?.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "", timedOut: false }));
    });
  const traces: Record<string, unknown>[] = [];
  const host: PullHost = { id: "sess-1", isChild: false, agentDir: agent, opener: "sess-1", python: "python3", config: undefined, notify: () => {}, trace: (r) => void traces.push(r) };
  const pull = createRemotePull({ host: () => host, spawner, pkgRoot: "/pkg", now: () => Date.parse("2026-10-25T12:00:00Z") });

  const p = pull.pullNow(CHILD);
  await inFlight;
  pull.stop();
  const out = await p;

  assert.equal(out.ok, false);
  assert.equal(out.error, "stopped");
  assert.equal(seen?.aborted, true);
  assert.equal(traces.filter((t) => t.event === "remote_pull").length, 0);
  assert.deepEqual(files(agent), before);
  assert.deepEqual(readRegistry(agent).sessions.length, 1);
});
