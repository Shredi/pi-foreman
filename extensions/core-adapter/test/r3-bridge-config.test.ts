// Security re-check round 3 (R3-H1): `.pi/claude-bridge.json` is part of the Claude-config drift
// snapshot, protected, judged by the session-start/doctor check; compaction and branch summaries
// on claude-bridge are cancelled on unapproved drift; the review link never calls claude-bridge
// with drift pending; removing or renaming the state folder's ancestors is asked/denied.
// Temp dirs only; executable paths point at files that do not exist. No Claude binary runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { ClaudeConfigWatch, takeClaudeSnapshot } from "../claudedrift.ts";
import { bridgeLoadOrder, projectBridgeConfigRisks, userBridgeConfigRisks } from "../bridgeiso.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PRINT = { mode: "print", hasUI: false };
const noTrace = () => undefined;

function tmp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function plantBridgeConfig(proj: string, data: unknown): void {
  fs.mkdirSync(path.join(proj, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".pi", "claude-bridge.json"), JSON.stringify(data));
}

test("R3-H1: .pi/claude-bridge.json is in the Claude-config snapshot; a pre-upgrade snapshot without it still loads", async (t) => {
  const state = tmp(t, "pf-r3s-");
  const proj = tmp(t, "pf-r3w-");
  const c = new ClaudeConfigWatch();
  assert.deepEqual(c.bind(state, proj), []);
  assert.equal(takeClaudeSnapshot(proj)[".pi/claude-bridge.json"], "absent");
  plantBridgeConfig(proj, { provider: { pathToClaudeCodeExecutable: path.join(proj, "no-such-cc") } });
  assert.deepEqual(c.pending(proj), [".pi/claude-bridge.json: created"]);
  assert.match((await c.check(proj, "x", PRINT, noTrace))?.reason ?? "", /no UI/);
  assert.equal(await c.check(proj, "x", { mode: "tui", hasUI: true, confirm: async () => true }, noTrace), undefined);
  assert.deepEqual(c.pending(proj), []);

  // A snapshot written before the file was tracked (three keys) is a stored snapshot, not tamper;
  // the existing bridge config shows as created once.
  const [snap] = fs.readdirSync(state).filter((n) => n.startsWith("claudecfg-") && n.endsWith(".json"));
  const stored = JSON.parse(fs.readFileSync(path.join(state, snap), "utf8"));
  delete stored.files[".pi/claude-bridge.json"];
  fs.writeFileSync(path.join(state, snap), JSON.stringify(stored));
  const again = new ClaudeConfigWatch();
  assert.deepEqual(again.bind(state, proj), [".pi/claude-bridge.json: created"]);
  assert.equal(again.tamper, null);
});

test("R3-H1: projectBridgeConfigRisks flags executable paths, AskClaude and strictMcpConfig false; not the harmless keys", (t) => {
  const proj = tmp(t, "pf-r3k-");
  assert.deepEqual(projectBridgeConfigRisks(proj), []);
  plantBridgeConfig(proj, { provider: { plan: "max", longContextExtraUsage: true, forceTwoHundredK: ["m"], autoMemoryEnabled: true, strictMcpConfig: true }, askClaude: { enabled: false, allowFullMode: true, defaultMode: "read", name: "Ask" }, startupNoticeShown: "2026-01-01" });
  assert.deepEqual(projectBridgeConfigRisks(proj), []);
  plantBridgeConfig(proj, { provider: { pathToClaudeCodeExecutable: path.join(proj, "no-such-cc"), strictMcpConfig: false, future: { helperCommand: "x" } }, askClaude: { enabled: true, defaultMode: "full" } });
  assert.deepEqual(projectBridgeConfigRisks(proj), ['.pi/claude-bridge.json (provider.pathToClaudeCodeExecutable, provider.future.helperCommand, askClaude.enabled, askClaude.defaultMode "full", provider.strictMcpConfig false)']);
  fs.writeFileSync(path.join(proj, ".pi", "claude-bridge.json"), "{ nope");
  assert.deepEqual(projectBridgeConfigRisks(proj), [".pi/claude-bridge.json (unreadable; the bridge ignores it)"]);
});

test("R3-H1: bridgeLoadOrder reads project then user packages", () => {
  const root = "/opt/pi-foreman";
  assert.equal(bridgeLoadOrder(undefined, ["npm:pi-subagents@0.75.0"], root), "no-bridge");
  assert.equal(bridgeLoadOrder(undefined, [root, "npm:pi-claude-bridge@0.9.1"], root), "foreman-first");
  assert.equal(bridgeLoadOrder(undefined, ["npm:pi-claude-bridge@0.9.1", root], root), "bridge-first");
  assert.equal(bridgeLoadOrder([{ source: "npm:pi-foreman@1.0.0" }], ["npm:pi-claude-bridge@0.9.1"], root), "foreman-first");
  assert.equal(bridgeLoadOrder(["npm:pi-claude-bridge@0.9.1"], [root], root), "bridge-first");
  assert.equal(bridgeLoadOrder(undefined, ["npm:pi-claude-bridge"], root), "unknown");
  // Pi stores a local checkout relative to the settings folder
  assert.equal(bridgeLoadOrder(undefined, ["npm:pi-claude-bridge@0.9.1", "../../opt/pi-foreman"], root, "/p/.pi", "/a/b"), "bridge-first");
  assert.equal(bridgeLoadOrder(undefined, ["../../opt/pi-foreman", "npm:pi-claude-bridge@0.9.1"], root, "/p/.pi", "/a/b"), "foreman-first");
});

test("user-level <agentDir>/claude-bridge.json: drift-checked (the bridge's own startupNoticeShown ignored), protected, judged with a WARN for an executable path", async (t) => {
  const root = tmp(t, "pf-r3u-");
  const state = path.join(root, "state");
  const proj = path.join(root, "proj");
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  for (const d of [state, proj, agentDir]) fs.mkdirSync(d, { recursive: true });
  const userCfg = path.join(agentDir, "claude-bridge.json");
  fs.writeFileSync(userCfg, JSON.stringify({ provider: { plan: "max" } }));
  const c = new ClaudeConfigWatch();
  assert.deepEqual(c.bind(state, proj, agentDir), []);
  fs.writeFileSync(userCfg, JSON.stringify({ provider: { plan: "max" }, startupNoticeShown: "2026-10-04" }));
  assert.deepEqual(c.pending(proj), [], "the bridge's own marker is not drift");
  fs.writeFileSync(userCfg, JSON.stringify({ provider: { plan: "max", pathToClaudeCodeExecutable: path.join(root, "no-such-cc") } }));
  assert.deepEqual(c.pending(proj), ["<agentDir>/claude-bridge.json: changed"]);
  assert.match((await c.check(proj, "x", PRINT, noTrace))?.reason ?? "", /no UI/);
  assert.deepEqual(new ClaudeConfigWatch().bind(state, proj, agentDir), ["<agentDir>/claude-bridge.json: changed"], "persists across sessions");

  const fresh = tmp(t, "pf-r3u2-");
  fs.writeFileSync(path.join(fresh, "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "2026-10-04" }));
  assert.equal(takeClaudeSnapshot(proj, fresh)["<agentDir>/claude-bridge.json"], "absent", "marker-only file = no settings");

  assert.deepEqual(userBridgeConfigRisks(agentDir), { fail: [], warn: ["provider.pathToClaudeCodeExecutable"] });
  fs.writeFileSync(userCfg, JSON.stringify({ askClaude: { enabled: true }, provider: { strictMcpConfig: false } }));
  assert.deepEqual(userBridgeConfigRisks(agentDir), { fail: ["askClaude.enabled", "provider.strictMcpConfig false"], warn: [] });
  assert.deepEqual(userBridgeConfigRisks(path.join(root, "none")), { fail: [], warn: [] });

  const r = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir, path.join(root, "pkg"));
  for (const [tool, input] of [
    ["write", { path: userCfg, content: "{}" }],
    ["bash", { command: "echo '{}' > ~/.pi/agent/claude-bridge.json" }],
  ] as Array<[string, Record<string, unknown>]>) {
    for (const [role, want] of [["main", "ask"], ["child", "deny"]] as const) {
      assert.equal(checkToolCall(r, tool, input, { cwd: proj, home, platform: process.platform, role })?.kind, want, `${role} ${tool}`);
    }
  }
});

test("R3-H1 / round 3: protect set covers .pi/claude-bridge.json and remove/rename of the state folder's ancestors", (t) => {
  const root = tmp(t, "pf-r3p-");
  const cwd = path.join(root, "proj");
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const pf = path.join(agentDir, "pi-foreman");
  fs.mkdirSync(path.join(pf, "state"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const r = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir, path.join(root, "pkg"));
  const kind = (tool: string, input: Record<string, unknown>, role: "main" | "child"): string => checkToolCall(r, tool, input, { cwd, home, platform: process.platform, role })?.kind ?? "pass";
  const bridgeCfg = path.join(cwd, ".pi", "claude-bridge.json");
  for (const [tool, input] of [
    ["write", { path: bridgeCfg, content: "{}" }],
    ["edit", { path: ".pi/claude-bridge.json", edits: [] }],
    ["bash", { command: "echo '{}' > .pi/claude-bridge.json" }],
    ["foreman_move", { src: "x.json", dst: ".pi/claude-bridge.json" }],
    ["bash", { command: "trash ~/.pi/agent/pi-foreman" }],
    ["bash", { command: "mv ~/.pi/agent/pi-foreman ~/.pi/agent/pf-old" }],
    ["bash", { command: `rm -r "$HOME/.pi/agent/pi-foreman/"` }],
    ["bash", { command: "rmdir ~/.pi/agent/pi-foreman" }],
    ["bash", { command: "trash ~/.pi/agent" }],
    ["bash", { command: `mv ${agentDir} ${path.join(root, "elsewhere")}` }],
    ["bash", { command: `python3 -c "import shutil; shutil.rmtree('${pf}')"` }],
    ["powershell", { command: `Remove-Item -Recurse ${pf}` }],
    ["foreman_move", { src: pf, dst: path.join(root, "pf") }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(kind(tool, input, "main"), "ask", `main ${tool} ${JSON.stringify(input)}`);
    assert.equal(kind(tool, input, "child"), "deny", `child ${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(kind("write", { path: path.join(cwd, "sub", ".pi", "claude-bridge.json"), content: "{}" }, "child"), "deny", "nested project bridge config: children denied");
  for (const [tool, input] of [
    ["bash", { command: "ls ~/.pi/agent/pi-foreman" }],
    ["bash", { command: "ls -la ~/.pi/agent" }],
    ["read", { path: pf }],
    ["ls", { path: agentDir }],
    ["foreman_copy", { src: pf, dst: path.join(root, "copy") }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(kind(tool, input, "main"), "pass", `main ${tool} ${JSON.stringify(input)}`);
    assert.equal(kind(tool, input, "child"), "pass", `child ${tool} ${JSON.stringify(input)}`);
  }
});

test("R3-H1: the review link defers instead of calling claude-bridge while drift is pending", async () => {
  let calls = 0;
  const registry: RegistryLike = { find: () => ({}), complete: async () => (calls++, { content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" }) };
  const config = { providers: { "claude-bridge": { review: { model: "claude-bridge/small" } }, other: { review: { model: "other/small" } } } };
  const bash = { requestId: "r1", surface: "bash", command: "uname -s" };
  let drift = [".pi/claude-bridge.json: created"];
  const r = new ForemanReview();
  r.upsert("s", { isChild: false, cwd: "/w", provider: "claude-bridge", config: () => config, registry, intent: "", bridgeDrift: () => drift });
  assert.deepEqual(await r.authorize("s", bash), { kind: "defer" });
  assert.equal(calls, 0, "never called with drift pending");
  r.upsert("o", { isChild: false, cwd: "/w", provider: "other", config: () => config, registry, intent: "", bridgeDrift: () => drift });
  assert.deepEqual(await r.authorize("o", bash), { kind: "allow" }, "other providers are not gated");
  drift = [];
  assert.deepEqual(await r.authorize("s", bash), { kind: "allow" });
  assert.equal(calls, 2);
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("R3-H1: session_before_compact / session_before_tree cancel on claude-bridge with unapproved drift", async (t) => {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_COUNT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (let i = 0; i < 8; i++) saved[`GIT_CONFIG_KEY_${i}`] = process.env[`GIT_CONFIG_KEY_${i}`], saved[`GIT_CONFIG_VALUE_${i}`] = process.env[`GIT_CONFIG_VALUE_${i}`];
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const root = tmp(t, "pf-r3c-");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const pi = { on: (n: string, h: Handler) => void handlers.set(n, h), registerCommand: () => undefined, registerTool: () => undefined, getActiveTools: () => [] as string[], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined };
  coreAdapter(pi as never);
  const notes: string[] = [];
  let answer = false;
  const ctx = (provider: string | undefined, hasUI: boolean) => ({
    sessionManager: { getSessionId: () => "r3-compact", getSessionFile: () => undefined },
    cwd: project,
    model: provider ? { provider, id: "m" } : undefined,
    mode: hasUI ? "tui" : "print",
    hasUI,
    isProjectTrusted: () => false,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string) => void notes.push(m), confirm: async () => answer },
  });
  await handlers.get("session_start")!({ reason: "startup" }, ctx(undefined, false));
  const compact = handlers.get("session_before_compact")!;
  const tree = handlers.get("session_before_tree")!;
  assert.equal(await compact({ reason: "threshold" }, ctx("claude-bridge", false)), undefined, "no drift: compaction proceeds");

  plantBridgeConfig(project, { provider: { pathToClaudeCodeExecutable: path.join(root, "no-such-cc") } });
  assert.equal(await compact({ reason: "manual" }, ctx("other", false)), undefined, "other provider: not gated");
  assert.deepEqual(await compact({ reason: "threshold" }, ctx("claude-bridge", false)), { cancel: true });
  assert.deepEqual(await tree({}, ctx("claude-bridge", false)), { cancel: true });
  assert.ok(notes.some((n) => /compaction summary was cancelled/.test(n)), notes.join("\n"));
  answer = false;
  assert.deepEqual(await compact({ reason: "threshold" }, ctx("claude-bridge", true)), { cancel: true }, "denied in the TUI");
  answer = true;
  assert.equal(await tree({}, ctx("claude-bridge", true)), undefined, "approved: re-baselined");
  assert.equal(await compact({ reason: "threshold" }, ctx("claude-bridge", false)), undefined, "approved state is the new baseline");
  await handlers.get("session_shutdown")!({}, ctx(undefined, false));
});
