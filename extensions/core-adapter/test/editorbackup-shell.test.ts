// The child editor_backup guard (index.ts tool_call, effects.ts editorBackupCommand) applies to every shell tool,
// not only bash: foreman_bg and the add-on's bg_run too. Temp dirs only; every case is refused before any spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { isShellTool } from "../toolmap.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function adapter(t: { after(fn: () => void): void }, toolNames: string[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-edbk-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "x", "agent");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => toolNames.map((name) => ({ name })),
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never);
  const ctx = {
    sessionManager: { getSessionId: () => "edbk-session-1", getSessionFile: () => undefined },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false },
  };
  return { handlers, ctx, project };
}

test("editor_backup guard: a child's rm of an editor backup is denied on bash, foreman_bg and bg_run alike", async (t) => {
  const a = adapter(t, ["bash", "bg_run"]);
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => delete process.env.PI_SUBAGENT_CHILD);
  const commands = ["rm -f src/a.ts~", "rm src/a.ts.bak", "rm -- src/a.ts.orig", "rm .#a.ts"];
  for (const tool of ["bash", "foreman_bg", "bg_run", "powershell"]) {
    assert.equal(isShellTool(tool), true, tool);
    for (const command of commands) {
      const d = (await a.handlers.get("tool_call")!({ toolName: tool, toolCallId: "x", input: { command } }, a.ctx)) as { block?: boolean; reason?: string } | undefined;
      assert.equal(d?.block, true, `${tool}: ${command}`);
      assert.match(d!.reason!, /\[editor_backup\] deleting an editor backup/, `${tool}: ${command}`);
    }
  }
});

test("editor_backup guard: a non-shell tool with a command field is not refused by this guard", async (t) => {
  const a = adapter(t, ["bash"]);
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => delete process.env.PI_SUBAGENT_CHILD);
  const d = (await a.handlers.get("tool_call")!({ toolName: "read", toolCallId: "x", input: { command: "rm -f src/a.ts~", path: "src/a.ts" } }, a.ctx)) as { reason?: string } | undefined;
  assert.doesNotMatch(d?.reason ?? "", /\[editor_backup\]/);
});
