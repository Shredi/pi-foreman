import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { bridgeAuthNotice, BRIDGE_PROVIDER } from "../bridgeiso.ts";
import { intercomBlock, remoteChildAddress } from "../intercomguard.ts";
import { parseSessionArgs, runSessionCommand, SESSION_USAGE, writeRegistry } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import type { SpawnResult } from "../spawn.ts";
import { trackedTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(trackedTmp("pf-restart-pr1-"));
const REMOTE_CHILD = "fm-demo-abc123";
const LOCAL_CHILD = "fm-local-def456";
const spawnOk = (stdout = "restarted", code = 0, stderr = ""): SpawnResult => ({ code, stdout, stderr, timedOut: false });
const MAIN = { isChild: false, allowRemote: false, allowOpenPane: false };

function agentWith(sessions: Record<string, unknown>[]): string {
  const agent = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(agent, { version: 1, sessions: sessions as never });
  return agent;
}
const sessionDeps = (agent: string, over: Partial<SessionDeps> = {}): SessionDeps => ({ isChild: false, env: {}, agentDir: agent, cwd: root, piSessionId: "sess-1", pkgRoot: "/pkg", python: "/usr/bin/python3", spawner: async () => spawnOk(), send: async () => "sent", confirm: async () => true, ...over });

test("/foreman session restart <label> parses to a restart command; no or extra target is the usage", () => {
  assert.deepEqual(parseSessionArgs("restart demo"), { sub: "restart", target: "demo" });
  assert.deepEqual(parseSessionArgs("restart"), { error: SESSION_USAGE });
  assert.deepEqual(parseSessionArgs("restart a b"), { error: SESSION_USAGE });
  assert.match(SESSION_USAGE, /session restart <label>/);
});

test("/foreman session restart runs the restart verb through the runner and shows its output or error", async () => {
  const agent = agentWith([]);
  const calls: string[][] = [];
  const ok = await runSessionCommand(sessionDeps(agent, { runRemote: async (a) => (calls.push(a), spawnOk("restarted demo")) }), "restart demo");
  assert.deepEqual(calls, [["restart", "demo"]]);
  assert.deepEqual([ok.ok, ok.text], [true, "restarted demo"]);
  const bad = await runSessionCommand(sessionDeps(agent, { runRemote: async () => spawnOk("", 1, "pi-foreman session: refused: demo still runs") }), "restart demo");
  assert.deepEqual([bad.ok, bad.text], [false, "pi-foreman session: refused: demo still runs"]);
  const bare = await runSessionCommand(sessionDeps(agent), "restart demo");
  assert.equal(bare.ok, false);
});

test("/foreman session restart is refused in a subagent child", async () => {
  const r = await runSessionCommand(sessionDeps(agentWith([]), { isChild: true }), "restart demo");
  assert.equal(r.ok, false);
});

// ---- 129: a bare id of a remote child

const entries = [
  { label: "demo", child: REMOTE_CHILD, status: "open", machine: "alpha", originMachine: "alpha-host", handoff: "/h/1" },
  { label: "demo", child: LOCAL_CHILD, status: "open", handoff: "/h/2" },
];

test("a send to the bare id of a remote child is refused with <id>@<machine> and intercom.allowRemote", () => {
  const agent = agentWith(entries);
  const policy = { ...MAIN, remoteAddressOf: (to: string) => remoteChildAddress(agent, to) };
  const reason = intercomBlock("intercom", { action: "send", to: REMOTE_CHILD, message: "hi" }, policy) ?? "";
  assert.ok(reason.includes(`${REMOTE_CHILD}@alpha-host`), reason);
  assert.match(reason, /intercom\.allowRemote/);
  assert.match(intercomBlock("intercom", { action: "send", to: REMOTE_CHILD, message: "hi" }, { ...policy, allowRemote: true }) ?? "", /Send to .*@alpha-host/);
});

test("name@machine targets and a local session with the same label are not affected by the bare-id refusal", () => {
  const agent = agentWith(entries);
  const policy = { ...MAIN, allowRemote: true, remoteAddressOf: (to: string) => remoteChildAddress(agent, to) };
  assert.equal(intercomBlock("intercom", { action: "send", to: `${REMOTE_CHILD}@alpha-host`, message: "hi" }, policy), undefined);
  assert.equal(intercomBlock("intercom", { action: "send", to: "demo", message: "hi" }, policy), undefined);
  assert.equal(intercomBlock("intercom", { action: "send", to: LOCAL_CHILD, message: "hi" }, policy), undefined);
  assert.equal(remoteChildAddress(agent, LOCAL_CHILD), undefined);
  assert.equal(remoteChildAddress(agent, "demo"), undefined);
  assert.equal(remoteChildAddress(path.join(root, "no-such-agent"), REMOTE_CHILD), undefined);
});

// ---- 124: the claude-bridge login

test("an auth failure (401/403) of claude-bridge names the isolated folder and `claude auth login`; nothing else does", () => {
  for (const status of [401, 403]) {
    const text = bridgeAuthNotice(BRIDGE_PROVIDER, status, "/iso/dir") ?? "";
    assert.ok(text.includes("CLAUDE_CONFIG_DIR=/iso/dir claude auth login"), text);
  }
  for (const status of [200, 400, 429, 500, "401", undefined]) assert.equal(bridgeAuthNotice(BRIDGE_PROVIDER, status, "/iso/dir"), undefined, String(status));
  assert.equal(bridgeAuthNotice("anthropic", 401, "/iso/dir"), undefined);
  assert.equal(bridgeAuthNotice(undefined, 401, "/iso/dir"), undefined);
});
