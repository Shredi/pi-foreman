import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseInbound, readRegistry, registerSession, writeRegistry } from "../session.ts";

delete process.env.PI_SUBAGENT_CHILD;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-inbound-")));

test("session inbound: foreman:plan and foreman:result aliases", () => {
  assert.deepEqual(parseInbound("foreman:plan /h/plan.md"), { kind: "plan", label: "", path: "/h/plan.md" });
  assert.deepEqual(parseInbound("foreman:result /h/result.md"), { kind: "result", label: "", path: "/h/result.md" });
  for (const t of ["foreman:plan", "foreman:plan ", "foreman:result a\nb", "foreman:planx /p", "foreman:update /p"]) assert.equal(parseInbound(t), null, t);
});

test("session inbound: an alias from a registry child updates the entry and notifies the child wait", async () => {
  const agent = path.join(root, "agent");
  writeRegistry(agent, { version: 1, sessions: [{ label: "phase1", child: "fm-phase1-abc123", status: "pending", handoff: "/h" }] });
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h) };
  const notices: unknown[][] = [];
  registerSession(pi as never, {
    spawner: async () => { throw new Error("no spawn"); },
    pkgRoot: "/pkg",
    session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }),
    onChildNotice: (...a) => void notices.push(a),
  });
  const notes: string[] = [];
  const ctx = { ui: { notify: (t: string) => void notes.push(t) }, sessionManager: { getBranch: () => [] } };
  const custom = (from: string, text: string, id: string) => ({ message: { role: "custom", customType: "intercom_message", details: { from: { id: from }, message: { id, content: { text } } } } });
  await handlers.get("message_end")!(custom("stranger", "foreman:plan /x/plan.md", "m0"), ctx);
  await handlers.get("message_end")!(custom("fm-phase1-abc123", "foreman:plan /h/plan.md", "m1"), ctx);
  await handlers.get("message_end")!(custom("fm-phase1-abc123", "foreman:result /h/result.md", "m2"), ctx);
  const e = readRegistry(agent).sessions[0];
  assert.equal(e.status, "open");
  assert.equal(e.result, "/h/result.md");
  assert.equal(e.last?.kind, "result");
  assert.deepEqual(notes, ["pi-foreman session phase1: plan /h/plan.md", "pi-foreman session phase1: result /h/result.md"]);
  assert.deepEqual(notices, [["sess-1", "phase1", "plan", "/h/plan.md"], ["sess-1", "phase1", "result", "/h/result.md"]]);
});
