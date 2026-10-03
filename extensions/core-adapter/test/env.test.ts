import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { buildGuardEnv, patchShellEnv, piAgentDir } from "../env.ts";

const host = {
  PATH: "/usr/bin",
  HOME: "/hd/u",
  TMPDIR: "/tmp/host",
  CLAUDE_CODE_SESSION_ID: "claude-sess",
  CLAUDE_CONFIG_DIR: "/hd/u/.claude-alt",
  FABLE_ORCH_MODE: "plain",
  LEDGER_WRITE_GUARD: "0",
  LEDGER: "/elsewhere/LEDGER.md",
  DESTRUCTIVE_GUARD: "0",
  claude_lowercase: "x",
};

test("guard env sets harness, plugin root and Pi session id", () => {
  const env = buildGuardEnv({ base: host, coreDir: "/pkg/core", sessionId: "pi-1", guard: "ledger_guard_spawn", markerDir: "/agent/pi-foreman/state" });
  assert.equal(env.FABLE_ORCH_HARNESS, "pi");
  assert.equal(env.CLAUDE_PLUGIN_ROOT, "/pkg/core");
  assert.equal(env.CLAUDE_CODE_SESSION_ID, "pi-1");
  assert.equal(env.PI_SESSION_ID, "pi-1");
  assert.equal(env.FABLE_ORCH_METRICS, "0");
  assert.equal(env.FABLE_ORCH_SWARM_CLEANUP, "0");
  assert.equal(env.PATH, "/usr/bin");
});

test("another harness's switches never leak into the core", () => {
  const env = buildGuardEnv({ base: host, coreDir: "/pkg/core", sessionId: "pi-1", guard: "destructive_guard", markerDir: "/m" });
  for (const k of ["CLAUDE_CONFIG_DIR", "FABLE_ORCH_MODE", "LEDGER_WRITE_GUARD", "LEDGER", "DESTRUCTIVE_GUARD", "claude_lowercase"]) {
    assert.equal(env[k], undefined, k);
  }
});

test("ledger scripts get TMPDIR = marker dir; the destructive guard keeps the host temp dir", () => {
  const gate = buildGuardEnv({ base: host, coreDir: "/c", sessionId: "s", guard: "ledger_bind", markerDir: "/m" });
  assert.equal(gate.TMPDIR, "/m");
  const dg = buildGuardEnv({ base: host, coreDir: "/c", sessionId: "s", guard: "destructive_guard", markerDir: "/m" });
  assert.equal(dg.TMPDIR, "/tmp/host");
});

test("spawn threshold knob is only set for the spawn gate", () => {
  assert.equal(buildGuardEnv({ base: {}, coreDir: "/c", sessionId: "s", guard: "ledger_guard_spawn", markerDir: "/m", threshold: 0 }).LEDGER_GUARD_THRESHOLD, "0");
  assert.equal(buildGuardEnv({ base: {}, coreDir: "/c", sessionId: "s", guard: "ledger_guard_spawn", markerDir: "/m", threshold: null }).LEDGER_GUARD_THRESHOLD, undefined);
  assert.equal(buildGuardEnv({ base: {}, coreDir: "/c", sessionId: "s", guard: "ledger_guard_stop", markerDir: "/m", threshold: 0 }).LEDGER_GUARD_THRESHOLD, undefined);
});

test("shell patch prepends bin once (Windows Path key too) and exports python + state dir", () => {
  const env: Record<string, string | undefined> = { Path: "C:\\Windows;C:\\bin" };
  patchShellEnv({ env, binDir: "C:\\pkg\\bin", python: "C:\\Py\\python.exe", markerDir: "C:\\state", delimiter: ";" });
  patchShellEnv({ env, binDir: "C:\\pkg\\bin", python: "C:\\Py\\python.exe", markerDir: "C:\\state", delimiter: ";" });
  assert.equal(env.Path, "C:\\pkg\\bin;C:\\Windows;C:\\bin");
  assert.equal(env.PATH, undefined);
  assert.equal(env.PI_FOREMAN_PYTHON, "C:\\Py\\python.exe");
  assert.equal(env.PI_FOREMAN_STATE_DIR, "C:\\state");
});

test("agent dir honours PI_CODING_AGENT_DIR", () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/hd/u"), "/tmp/agent");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~/a" }, "/hd/u"), path.join("/hd/u", "a"));
  assert.equal(piAgentDir({}, "/hd/u"), path.join("/hd/u", ".pi", "agent"));
});
