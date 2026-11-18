// The open script's environment: the running Pi's launch words and the start check ride along; the opener's own PATH and agent dir stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSessionOpenTool, SESSION_OPEN_TOOL } from "../session.ts";
import type { SpawnOptions, SpawnResult } from "../spawn.ts";

test("the open spawn passes PI_FOREMAN_PI_ARGV and the start check, and keeps PATH and the agent dir", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-open-env-")));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(root, "b.md"), "# Title\nbody\n");
  const saved = { path: process.env.PATH, agent: process.env.PI_CODING_AGENT_DIR, check: process.env.PI_FOREMAN_START_CHECK_SECONDS, child: process.env.PI_SUBAGENT_CHILD };
  process.env.PATH = "/opt/opener/bin";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_FOREMAN_START_CHECK_SECONDS = "0";
  delete process.env.PI_SUBAGENT_CHILD;
  const seen: SpawnOptions[] = [];
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const pi = { events: undefined, getCommands: () => [], registerTool: (t: { name: string; execute: never }) => void tools.set(t.name, t), sendMessage: () => {} };
  registerSessionOpenTool(pi as never, {
    spawner: async (_cmd: string, _args: string[], options: SpawnOptions): Promise<SpawnResult> => {
      seen.push(options);
      return { code: 0, stdout: "handoff: x", stderr: "", timedOut: false };
    },
    pkgRoot: "/pkg",
    session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir, python: "/usr/bin/python3", config: { sessions: { confirmWaitSeconds: 0.05 } } }),
  });
  const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { confirm: async () => true } };
  try {
    await tools.get(SESSION_OPEN_TOOL)!.execute("c1", { label: "demo", brief: "b.md" }, undefined, undefined, ctx);
    assert.equal(seen.length, 1);
    const env = seen[0].env!;
    assert.equal(env.PATH, "/opt/opener/bin");
    assert.equal(env.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(env.PI_FOREMAN_START_CHECK_SECONDS, "3");
    const cli = process.argv[1];
    if (cli && path.isAbsolute(cli) && fs.statSync(cli).isFile()) assert.deepEqual(JSON.parse(env.PI_FOREMAN_PI_ARGV), [process.execPath, cli]);
    else assert.equal(env.PI_FOREMAN_PI_ARGV, undefined);
  } finally {
    for (const [k, v] of [["PATH", saved.path], ["PI_CODING_AGENT_DIR", saved.agent], ["PI_FOREMAN_START_CHECK_SECONDS", saved.check], ["PI_SUBAGENT_CHILD", saved.child]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
