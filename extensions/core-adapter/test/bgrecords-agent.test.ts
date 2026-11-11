import { test } from "node:test";
import assert from "node:assert/strict";
import { createBgRecords, installBgRecords, recordKey, BG_REQUEST_CHANNEL, BG_RESPONSE_CHANNEL, BG_TERMINAL_CHANNEL } from "../bgrecords.ts";

const setup = () => {
  const out: string[] = [];
  const r = createBgRecords({ write: (d) => out.push(d), env: { HERDR_PANE_ID: "w1:p1" }, mode: () => "tui", isTTY: true });
  return { r, out };
};
const frame = (id: string, status: string, extra: Record<string, unknown> = {}, name = "build") => ({ schema_version: "pi-background-tasks.extension-terminal.v1", task: { id, name, command: "make", status, ...extra } });

test("recordKey: the agent root only for an agent-marked task", () => {
  assert.equal(recordKey("abc", true), "background-agents/abc");
  assert.equal(recordKey("abc", false), "background-tasks/abc");
  assert.equal(recordKey("abc"), "background-tasks/abc");
});

test("post: agent true keys background-agents/, false or missing keys background-tasks/; the name does not decide", () => {
  const { r, out } = setup();
  r.post("a1", "working", "build", "Running", true);
  r.post("t1", "working", "build", "Running", false);
  r.post("t2", "working", "build", "Running");
  r.post("n1", "working", "explorer", "Running");
  assert.match(out[0], /state=working:id=background-agents\/a1:/);
  assert.match(out[1], /state=working:id=background-tasks\/t1:/);
  assert.match(out[2], /state=working:id=background-tasks\/t2:/);
  assert.match(out[3], /state=working:id=background-tasks\/n1:/);
});

test("a foreman_bg-style post (no flag) stays background-tasks/", () => {
  const { r, out } = setup();
  r.post("fb-7", "working", "sleep 60", "Running");
  r.post("fb-7", "done", "sleep 60", "Killed");
  assert.match(out[0], /id=background-tasks\/fb-7:/);
  assert.match(out[1], /state=done:id=background-tasks\/fb-7:/);
});

test("terminal frame flips the key the record was posted under; a never-seen id uses its own isAgent", () => {
  const { r, out } = setup();
  r.onRunning("a1", "build", true);
  r.onTerminal(frame("a1", "completed", { isAgent: false }));
  assert.match(out[1], /state=done:id=background-agents\/a1:/);
  r.onTerminal(frame("a2", "failed", { isAgent: true }));
  assert.match(out[2], /state=error:id=background-agents\/a2:/);
  r.onTerminal(frame("a3", "killed"));
  assert.match(out[3], /state=done:id=background-tasks\/a3:/);
  assert.ok(out[3].includes(`msg=${Buffer.from("Killed", "utf-8").toString("base64")}`));
});

test("clear and clearAll use the key the record was posted under", () => {
  const { r, out } = setup();
  r.post("c1", "working", "t", "m", true);
  r.post("c2", "working", "t", "m", true);
  r.post("c3", "working", "t", "m");
  r.clear("c1");
  assert.equal(out[out.length - 1], "\x1b]7501;state=clear:id=background-agents/c1\x1b\\");
  out.length = 0;
  r.clearAll();
  assert.deepEqual(out, ["\x1b]7501;state=clear:id=background-agents/c2\x1b\\", "\x1b]7501;state=clear:id=background-tasks/c3\x1b\\"]);
});

test("the cap eviction clears the agent key, and forgets its kind", () => {
  const { r, out } = setup();
  for (let i = 0; i < 64; i++) r.post(`a${i}`, "working", "t", "m", true);
  out.length = 0;
  r.post("zz", "working", "t", "m");
  assert.equal(out[0], "\x1b]7501;state=clear:id=background-agents/a0\x1b\\");
  out.length = 0;
  r.clear("a0");
  assert.deepEqual(out, [], "a0 is gone: nothing left to clear");
});

test("installBgRecords: bg_run result input.isAgent picks the key; a result without input is a shell task", async () => {
  const handlers: Record<string, ((...a: any[]) => Promise<void>)[]> = {};
  const subs: Record<string, ((d: unknown) => void)[]> = {};
  const bus = {
    emit: (ch: string, data: unknown) => {
      for (const h of subs[ch] ?? []) h(data);
    },
    on: (ch: string, h: (d: unknown) => void) => {
      (subs[ch] ??= []).push(h);
      return () => void (subs[ch] = (subs[ch] ?? []).filter((x) => x !== h));
    },
  };
  const pi = { on: (n: string, h: any) => void (handlers[n] ??= []).push(h), events: bus } as any;
  const out: string[] = [];
  installBgRecords(pi, { env: { HERDR_PANE_ID: "p" }, platform: "linux", write: (d) => out.push(d), isTTY: true, setTimeout: () => 0, clearTimeout: () => undefined });
  await handlers.session_start[0]({ reason: "startup" }, { mode: "tui" });
  await handlers.tool_result[0]({ toolName: "bg_run", isError: false, input: { command: "npm test", isAgent: true }, content: [{ type: "text", text: "Started npm test (a1)\nOutput: /x" }] });
  await handlers.tool_result[0]({ toolName: "bg_run", isError: false, input: { command: "make", isAgent: false }, content: [{ type: "text", text: "Started make (t1)" }] });
  await handlers.tool_result[0]({ toolName: "bg_run", isError: false, content: [{ type: "text", text: "Started lint (t2)" }] });
  assert.match(out[0], /state=working:id=background-agents\/a1:/);
  assert.match(out[1], /state=working:id=background-tasks\/t1:/);
  assert.match(out[2], /state=working:id=background-tasks\/t2:/);
  await handlers.session_shutdown[0]({ reason: "quit" });
});

test("installBgRecords: status-response tasks use t.isAgent; the terminal frame flips the same key", async () => {
  const handlers: Record<string, ((...a: any[]) => Promise<void>)[]> = {};
  const subs: Record<string, ((d: unknown) => void)[]> = {};
  const emitted: { ch: string; data: any }[] = [];
  const bus = {
    emit: (ch: string, data: unknown) => {
      emitted.push({ ch, data });
      for (const h of subs[ch] ?? []) h(data);
    },
    on: (ch: string, h: (d: unknown) => void) => {
      (subs[ch] ??= []).push(h);
      return () => void (subs[ch] = (subs[ch] ?? []).filter((x) => x !== h));
    },
  };
  const pi = { on: (n: string, h: any) => void (handlers[n] ??= []).push(h), events: bus } as any;
  const out: string[] = [];
  installBgRecords(pi, { env: { HERDR_PANE_ID: "p" }, platform: "linux", write: (d) => out.push(d), isTTY: true, setTimeout: () => 0, clearTimeout: () => undefined });
  await handlers.session_start[0]({ reason: "reload" }, { mode: "tui" });
  const req = emitted.find((e) => e.ch === BG_REQUEST_CHANNEL)!.data;
  bus.emit(BG_RESPONSE_CHANNEL, { schema_version: "pi-background-tasks.extension-response.v1", request_id: req.request_id, operation: "status", ok: true, result: { tasks: [{ id: "s1", name: "serve", status: "running", isAgent: true }, { id: "s2", name: "make", status: "running" }] } });
  assert.equal(out.length, 2);
  assert.match(out[0], /state=working:id=background-agents\/s1:/);
  assert.match(out[1], /state=working:id=background-tasks\/s2:/);
  bus.emit(BG_TERMINAL_CHANNEL, frame("s1", "completed", {}, "serve"));
  assert.match(out[2], /state=done:id=background-agents\/s1:/);
  await handlers.session_shutdown[0]({ reason: "quit" });
});
