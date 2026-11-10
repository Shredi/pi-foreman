import { test } from "node:test";
import assert from "node:assert/strict";
import { createBgRecords, installBgRecords, oscReport, parseStarted, recordKey, BG_REQUEST_CHANNEL, BG_RESPONSE_CHANNEL, BG_TERMINAL_CHANNEL } from "../bgrecords.ts";

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");
const setup = (over: { env?: Record<string, string>; mode?: string; platform?: string; isTTY?: boolean } = {}) => {
  const out: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const r = createBgRecords({ write: (d) => out.push(d), env: over.env ?? { HERDR_PANE_ID: "w1:p1" }, platform: over.platform ?? "linux", mode: () => over.mode ?? "tui", isTTY: over.isTTY ?? true, trace: (t) => traces.push(t) });
  return { r, out, traces };
};
const frame = (id: string, status: string, name = "build") => ({ schema_version: "pi-background-tasks.extension-terminal.v1", task: { id, name, command: "make", status } });

test("start posts one working OSC with the key, app and base64 title", () => {
  const { r, out, traces } = setup();
  r.post("abc", "working", "build", "Running");
  assert.equal(out.length, 1);
  assert.equal(out[0], `\x1b]7501;state=working:id=background-tasks/abc:app=pi-foreman:title=${b64("build")}:msg=${b64("Running")}\x1b\\`);
  assert.deepEqual(traces, [{ event: "bgrecord", decision: "working" }]);
  r.post("abc", "working", "build", "Running");
  assert.equal(out.length, 1, "an identical repost writes nothing");
});

test("end: completed is done, failed is error, killed is done with msg Killed", () => {
  const { r, out } = setup();
  r.onRunning("a", "build");
  r.onTerminal(frame("a", "completed"));
  r.onTerminal(frame("b", "failed"));
  r.onTerminal(frame("c", "killed"));
  assert.match(out[1], /state=done:id=background-tasks\/a:/);
  assert.ok(out[1].includes(`msg=${b64("Finished")}`));
  assert.match(out[2], /state=error:id=background-tasks\/b:/);
  assert.match(out[3], /state=done:id=background-tasks\/c:/);
  assert.ok(out[3].includes(`msg=${b64("Killed")}`));
});

test("terminal frame: unknown id posts done directly; a late start does not revive it; malformed frames are ignored", () => {
  const { r, out } = setup();
  r.onTerminal(frame("z", "completed"));
  assert.equal(out.length, 1);
  r.onRunning("z", "build");
  assert.equal(out.length, 1);
  r.onTerminal(null);
  r.onTerminal({ schema_version: "x", task: { id: "q", status: "completed" } });
  r.onTerminal({ schema_version: "pi-background-tasks.extension-terminal.v1", task: { id: "q", status: "running" } });
  r.onTerminal({ schema_version: "pi-background-tasks.extension-terminal.v1", task: { status: "completed" } });
  assert.equal(out.length, 1);
});

test("clearAll clears every sent id and none that was never sent", () => {
  const { r, out } = setup();
  r.post("a", "working", "t", "m");
  r.post("b", "working", "t", "m");
  out.length = 0;
  r.clearAll();
  assert.deepEqual(out, ["\x1b]7501;state=clear:id=background-tasks/a\x1b\\", "\x1b]7501;state=clear:id=background-tasks/b\x1b\\"]);
  out.length = 0;
  r.clear("never");
  r.clearAll();
  assert.deepEqual(out, []);
});

test("gate: no hc terminal, PI_PROGRAM_STATUS=0, non-tui, no tty, dumb TERM: zero writes and no trace", () => {
  for (const over of [{ env: {} }, { env: { HC_TERMINAL_ID: "m/t", PI_PROGRAM_STATUS: "0" } }, { env: { HERDR_PANE_ID: "p" }, mode: "rpc" }, { env: { HERDR_PANE_ID: "p" }, isTTY: false }, { env: { HERDR_PANE_ID: "p", TERM: "dumb" } }]) {
    const { r, out, traces } = setup(over);
    r.post("a", "working", "t", "m");
    r.onTerminal(frame("b", "completed"));
    r.clear("a");
    r.clearAll();
    assert.deepEqual(out, [], JSON.stringify(over));
    assert.deepEqual(traces, []);
  }
  const { r, out } = setup({ env: { HC_TERMINAL_ID: "m/t" } });
  r.post("a", "working", "t", "m");
  assert.equal(out.length, 1, "HC_TERMINAL_ID alone opens the gate");
});

test("win32 and linux produce the same bytes", () => {
  const a = setup({ platform: "win32" });
  const b = setup({ platform: "linux" });
  a.r.post("x", "working", "t", "m");
  b.r.post("x", "working", "t", "m");
  assert.deepEqual(a.out, b.out);
});

test("keys and caps: key sanitized to 12 characters; title cut at 192 bytes on a character boundary; 64 records", () => {
  assert.equal(recordKey("abcdefghijklmnop"), "background-tasks/abcdefghijkl");
  assert.equal(recordKey("a.b/c"), "background-tasks/a-b-c");
  const long = oscReport({ state: "working", id: "a", title: "é".repeat(200), msg: "m" });
  const title = /title=([^:]*):/.exec(long)![1];
  assert.equal(Buffer.from(title, "base64").length, 192);
  const { r, out } = setup();
  for (let i = 0; i < 70; i++) r.post(`t${i}`, "working", "t", "m");
  assert.equal(out.filter((o) => o.includes("state=clear")).length, 6);
});

test("bg_run result parser: name and id from the first line", () => {
  assert.deepEqual(parseStarted("Started npm test (a1b2c3d4)\nOutput: /x\nCommand: npm test"), { name: "npm test", id: "a1b2c3d4" });
  assert.equal(parseStarted("No task"), null);
});

test("bg_run result parser: the add-on's real first line carries 'background task'", () => {
  assert.deepEqual(parseStarted("Started background task sleep 90 (a1b2c3d4)\nStatus: running\nPID: 123\nOutput: /x"), { name: "sleep 90", id: "a1b2c3d4" });
});

test("installBgRecords: status request after session_start re-posts running tasks, terminal frame flips, shutdown clears", async () => {
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
  installBgRecords(pi, { env: { HERDR_PANE_ID: "p" }, platform: "linux", write: (d) => out.push(d), isTTY: true });
  await handlers.session_start[0]({ reason: "reload" }, { mode: "tui" });
  const req = emitted.find((e) => e.ch === BG_REQUEST_CHANNEL)!.data;
  assert.equal(req.operation, "status");
  bus.emit(BG_RESPONSE_CHANNEL, { schema_version: "pi-background-tasks.extension-response.v1", request_id: req.request_id, operation: "status", ok: true, result: { tasks: [{ id: "r1", name: "serve", status: "running" }, { id: "d1", name: "old", status: "completed" }] } });
  assert.equal(out.length, 1);
  assert.match(out[0], /state=working:id=background-tasks\/r1:/);
  bus.emit(BG_TERMINAL_CHANNEL, frame("r1", "completed", "serve"));
  assert.match(out[1], /state=done:id=background-tasks\/r1:/);
  await handlers.tool_result[0]({ toolName: "bg_run", isError: false, content: [{ type: "text", text: "Started lint (l9)\nOutput: /x" }] });
  assert.match(out[2], /state=working:id=background-tasks\/l9:/);
  await handlers.session_shutdown[0]({ reason: "reload" });
  assert.equal(out.filter((o) => o.includes("state=clear")).length, 2);
  assert.equal((subs[BG_TERMINAL_CHANNEL] ?? []).length, 0);
});

test("installBgRecords: not under hc, nothing is requested or written", async () => {
  const handlers: Record<string, ((...a: any[]) => Promise<void>)[]> = {};
  const emitted: unknown[] = [];
  const pi = { on: (n: string, h: any) => void (handlers[n] ??= []).push(h), events: { emit: (...a: unknown[]) => emitted.push(a), on: () => () => undefined } } as any;
  const out: string[] = [];
  installBgRecords(pi, { env: {}, write: (d) => out.push(d), isTTY: true });
  await handlers.session_start[0]({ reason: "startup" }, { mode: "tui" });
  await handlers.tool_result[0]({ toolName: "bg_run", isError: false, content: [{ type: "text", text: "Started a (b)" }] });
  await handlers.session_shutdown[0]({ reason: "quit" });
  assert.deepEqual(out, []);
  assert.deepEqual(emitted, []);
});
