import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { INTERCOM_OUTBOX_EVENT, INTERCOM_OUTBOX_RESULT_EVENT } from "../close.ts";
import { INTERCOM_WAKE_TEXT } from "../usage.ts";
import { CHILD_REFUSAL, openerIntercomId, parseInbound, parseSessionArgs, readRegistry, registerSession, runSessionCommand, writeRegistry } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-")));
const seed = (agentDir: string) => writeRegistry(agentDir, { version: 1, sessions: [{ label: "demo", child: "fm-demo-abc123", status: "open", handoff: "/h" }] });

function deps(agentDir: string, over: Partial<SessionDeps> = {}): SessionDeps & { sent: [string, string][]; spawned: string[][] } {
  const sent: [string, string][] = [];
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir,
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async (to, text) => (sent.push([to, text]), "sent"),
    sent,
    spawned,
    ...over,
  };
}

test("session: argument parsing", () => {
  assert.deepEqual(parseSessionArgs("open demo b.md --cwd ../x --model p/m --plan-first --focus --dry-run"), { sub: "open", label: "demo", brief: "b.md", cwd: "../x", model: "p/m", planFirst: true, focus: true, dryRun: true });
  assert.deepEqual(parseSessionArgs("brief demo  go ahead  with B"), { sub: "brief", target: "demo", body: "go ahead  with B" });
  assert.deepEqual(parseSessionArgs("close demo .workflow/r.md"), { sub: "close", target: "demo", path: ".workflow/r.md" });
  assert.deepEqual(parseSessionArgs("list"), { sub: "list" });
  for (const bad of ["", "open demo", "open demo b.md --cwd", "open demo b.md --bogus", "close", "brief demo", "kill demo"]) assert.ok("error" in parseSessionArgs(bad), bad);
});

test("session: opener id follows pi-intercom (env, config stableId, Pi session id)", () => {
  const agent = path.join(root, "agent-id");
  assert.equal(openerIntercomId({}, agent, "sess-1"), "sess-1");
  fs.mkdirSync(path.join(agent, "intercom"), { recursive: true });
  fs.writeFileSync(path.join(agent, "intercom", "config.json"), JSON.stringify({ stableId: " cfg-id " }));
  assert.equal(openerIntercomId({}, agent, "sess-1"), "cfg-id");
  assert.equal(openerIntercomId({ PI_INTERCOM_STABLE_ID: "env-id" }, agent, "sess-1"), "env-id");
});

test("session: subagent children refuse every subcommand", async () => {
  const agent = path.join(root, "agent-child");
  for (const args of ["open demo b.md", "brief demo hi", "close demo", "list"]) {
    for (const over of [{ isChild: true }, { env: { PI_SUBAGENT_CHILD: "1" } }]) {
      const d = deps(agent, over);
      assert.deepEqual(await runSessionCommand(d, args), { text: CHILD_REFUSAL, ok: false });
      assert.equal(d.sent.length + d.spawned.length, 0);
    }
  }
});

test("session: open passes the opener id and absolute paths to the script", async () => {
  const d = deps(path.join(root, "agent-open"));
  const r = await runSessionCommand(d, "open demo b.md --model p/m --dry-run");
  assert.equal(r.ok, true);
  const a = d.spawned[0];
  assert.deepEqual(a.slice(0, 3), ["-E", "-s", path.join("/pkg", "scripts", "foreman_session.py")]);
  assert.deepEqual(a.slice(3), ["--agent-dir", d.agentDir, "open", "demo", path.join(root, "b.md"), "--cwd", root, "--parent-id", "sess-1", "--model", "p/m", "--dry-run"]);
});

test("session: brief and close resolve registry targets and send the contract texts", async () => {
  const agent = path.join(root, "agent-send");
  seed(agent);
  const file = path.join(root, "brief2.md");
  fs.writeFileSync(file, "x");
  const d = deps(agent, { env: { PI_INTERCOM_STABLE_ID: "opener-1" } });
  await runSessionCommand(d, "brief demo brief2.md");
  await runSessionCommand(d, "brief other-session decision: use B");
  await runSessionCommand(d, "close fm-demo-abc123 .workflow/r.md");
  assert.deepEqual(d.sent, [
    ["fm-demo-abc123", `Brief from opener-1: read ${file} and act on it`],
    ["other-session", "decision: use B"],
    ["fm-demo-abc123", "foreman:close .workflow/r.md"],
  ]);
  assert.equal(readRegistry(agent).sessions[0].status, "closing");
  assert.equal((await runSessionCommand(d, "close demo ../r.txt")).ok, false);
  assert.equal(d.sent.length, 3);
});

test("session: command sends through the pi-intercom outbox event", async () => {
  const agent = path.join(root, "agent-outbox");
  seed(agent);
  const emitted: [string, Record<string, unknown>][] = [];
  const listeners = new Map<string, (d: unknown) => void>();
  const events = {
    emit: (ch: string, data: Record<string, unknown>) => {
      emitted.push([ch, data]);
      if (ch === INTERCOM_OUTBOX_EVENT) listeners.get(INTERCOM_OUTBOX_RESULT_EVENT)?.({ version: 1, requestId: data.requestId, status: "sent" });
    },
    on: (ch: string, h: (d: unknown) => void) => (listeners.set(ch, h), () => listeners.delete(ch)),
  };
  const pi = { on: () => undefined, events };
  const notes: string[] = [];
  const s = registerSession(pi as never, { spawner: async () => { throw new Error("no spawn"); }, pkgRoot: "/pkg", session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }) });
  await s.command(" close demo", { ui: { notify: (t: string) => void notes.push(t) } } as never);
  assert.equal(emitted.length, 1);
  const [ch, payload] = emitted[0];
  assert.equal(ch, INTERCOM_OUTBOX_EVENT);
  assert.deepEqual({ ...payload, requestId: typeof payload.requestId }, { version: 1, requestId: "string", extensionId: "pi-foreman", extensionName: "pi-foreman", to: "fm-demo-abc123", message: "foreman:close" });
  assert.match(notes[0], /close request sent to fm-demo-abc123/);
});

test("session: inbound reports from a registry child update the registry (display only)", async () => {
  assert.deepEqual(parseInbound("Result from demo: /h/result.md"), { kind: "result", label: "demo", path: "/h/result.md" });
  assert.deepEqual(parseInbound("foreman:closed /w/.workflow/r.md"), { kind: "closed", path: "/w/.workflow/r.md" });
  for (const t of ["Result from demo:", "result from demo: x", "foreman:close x", "Plan from demo: a\nb", 3]) assert.equal(parseInbound(t), null, String(t));
  const agent = path.join(root, "agent-in");
  seed(agent);
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h) };
  registerSession(pi as never, { spawner: async () => { throw new Error("no spawn"); }, pkgRoot: "/pkg", session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }) });
  const notes: string[] = [];
  const msg = (from: string, text: string, id: string) => ({ from: { id: from }, message: { id, content: { text } } });
  const ctx = (branch: unknown[] = []) => ({ ui: { notify: (t: string) => void notes.push(t) }, sessionManager: { getBranch: () => branch } });
  const custom = (details: unknown) => ({ message: { role: "custom", customType: "intercom_message", details } });
  await handlers.get("message_end")!(custom(msg("someone-else", "Result from demo: /x.md", "m0")), ctx());
  await handlers.get("message_end")!(custom(msg("fm-demo-abc123", "Plan from demo: /h/plan.md", "m1")), ctx());
  assert.equal(readRegistry(agent).sessions[0].last?.kind, "plan");
  const branch = [{ type: "custom_message", customType: "intercom_message", details: msg("fm-demo-abc123", "foreman:closed /w/.workflow/r.md", "m2") }];
  assert.deepEqual(await handlers.get("input")!({ text: INTERCOM_WAKE_TEXT, source: "extension" }, ctx(branch)), { action: "continue" });
  await handlers.get("message_end")!(custom(branch[0].details), ctx()); // the same message again: once only
  const e = readRegistry(agent).sessions[0];
  assert.equal(e.status, "closed");
  assert.equal(e.result, "/w/.workflow/r.md");
  assert.deepEqual(notes, ["pi-foreman session demo: plan /h/plan.md", "pi-foreman session demo: closed /w/.workflow/r.md"]);
});
