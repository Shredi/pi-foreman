// Ledger 10a: a child that gets the same refusal twice (same tool, same reason after whitespace normalising) is stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { RepeatRefusals, REPEAT_STOP_TEXT } from "../repeatguard.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(t: { after(fn: () => void): void }, child: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rep-")));
  const saved = { a: process.env.PI_CODING_AGENT_DIR, c: process.env.PI_SUBAGENT_CHILD };
  t.after(() => {
    rmTestTmp(root);
    if (saved.a === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.a;
    if (saved.c === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = saved.c;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "bg_run" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never);
  let aborts = 0;
  const ctx = {
    sessionManager: { getSessionId: () => "rep-session", getSessionFile: () => undefined },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    abort: () => void aborts++,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
  };
  const call = (tool: string) => handlers.get("tool_call")!({ toolName: tool, toolCallId: "x", input: { command: "rm -f a.ts~" } }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
  const traces = (): Record<string, unknown>[] => {
    const dir = path.join(agentDir, "pi-foreman", "state");
    const out: Record<string, unknown>[] = [];
    try {
      for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("trace-"))) for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) out.push(JSON.parse(l));
    } catch {
      // none yet
    }
    return out;
  };
  return { handlers, ctx, call, traces, aborts: () => aborts };
}

test("RepeatRefusals: first is recorded, same tool + same normalised reason is a repeat, other tool or reason is not", () => {
  const r = new RepeatRefusals();
  assert.equal(r.note("bash", "no  way\n"), false);
  assert.equal(r.note("bash", "no way"), true);
  assert.equal(r.note("bg_run", "no way"), false);
  assert.equal(r.note("bash", "another reason"), false);
});

test("child: one refusal continues; the second identical refusal stops the run with the text and a child_probe_stop trace", async (t) => {
  const a = setup(t, true);
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  const first = await a.call("bash");
  assert.equal(first?.block, true);
  assert.match(first!.reason!, /editor_backup/);
  assert.equal(a.aborts(), 0);
  const second = await a.call("bash");
  assert.equal(second?.block, true);
  assert.ok(second!.reason!.includes(REPEAT_STOP_TEXT), second!.reason);
  assert.equal(a.aborts(), 1);
  const ev = a.traces().filter((r) => r.event === "child_probe_stop");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].tool, "bash");
  assert.match(String(ev[0].reason), /editor_backup/);
  assert.ok("role" in ev[0]);
});

test("child: two different refusals (different tools) do not stop the run", async (t) => {
  const a = setup(t, true);
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  const x = await a.call("bash");
  const y = await a.call("bg_run");
  assert.doesNotMatch(x!.reason!, /repeated guarded-token probe/);
  assert.doesNotMatch(y!.reason!, /repeated guarded-token probe/);
  assert.equal(a.aborts(), 0);
  assert.equal(a.traces().filter((r) => r.event === "child_probe_stop").length, 0);
});

test("foreman session: the same call twice is never stopped", async (t) => {
  const a = setup(t, false);
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  for (let i = 0; i < 3; i++) {
    const r = await a.call("bash");
    assert.doesNotMatch(r?.reason ?? "", /repeated guarded-token probe/);
  }
  assert.equal(a.aborts(), 0);
  assert.equal(a.traces().filter((r) => r.event === "child_probe_stop").length, 0);
});
