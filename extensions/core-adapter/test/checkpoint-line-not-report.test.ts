// The child owns its plan (PR 4): before its checkpoint a local child tells its parent `<label> waits on the owner at its plan
// checkpoint` in a plain line (a footer rule). The line is outside the message contract on purpose: it is not parsed as a report
// and changes no registry field on the parent's side (an `Update from` line would be written into the registry).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseInbound, readRegistry, registerSession, writeRegistry } from "../session.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const LINE = "phase1 waits on the owner at its plan checkpoint";

test("the checkpoint line is no report: parseInbound gives null, and the parent's registry and notices stay unchanged", async (t) => {
  delete process.env.PI_SUBAGENT_CHILD;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ck-line-")));
  t.after(() => rmTestTmp(root));
  assert.equal(parseInbound(LINE), null);
  const agent = path.join(root, "agent");
  writeRegistry(agent, { version: 1, sessions: [{ label: "phase1", child: "fm-phase1-abc123", status: "open", handoff: "/h", result: "/h/result.md" }] });
  const regFile = fs.readdirSync(agent, { recursive: true }).map(String).find((n) => n.endsWith(".json"))!;
  const before = fs.readFileSync(path.join(agent, regFile), "utf8");
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
  const ctx = { ui: { notify: (m: string) => void notes.push(m) }, sessionManager: { getBranch: () => [] } };
  const custom = (text: string, id: string) => ({ message: { role: "custom", customType: "intercom_message", details: { from: { id: "fm-phase1-abc123" }, message: { id, content: { text } } } } });
  await handlers.get("message_end")!(custom(LINE, "m1"), ctx);
  assert.equal(fs.readFileSync(path.join(agent, regFile), "utf8"), before, "no registry field changes");
  assert.deepEqual(readRegistry(agent).sessions[0].last, undefined);
  assert.deepEqual(notes, []);
  assert.deepEqual(notices, []);
  // control: an Update line from the same child is a report and is recorded
  await handlers.get("message_end")!(custom("Update from phase1: /h/update.md", "m2"), ctx);
  assert.equal(readRegistry(agent).sessions[0].last?.kind, "update");
});
