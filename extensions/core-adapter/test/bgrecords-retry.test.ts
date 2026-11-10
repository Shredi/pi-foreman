import { test } from "node:test";
import assert from "node:assert/strict";
import { installBgRecords, BG_REQUEST_CHANNEL, BG_RESPONSE_CHANNEL } from "../bgrecords.ts";

function rig(answer: (req: any, n: number) => any | undefined) {
  const handlers: Record<string, ((...a: any[]) => Promise<void>)[]> = {};
  const subs: Record<string, ((d: unknown) => void)[]> = {};
  let requests = 0;
  const bus = {
    emit: (ch: string, data: any) => {
      for (const h of subs[ch] ?? []) h(data);
      if (ch === BG_REQUEST_CHANNEL) {
        const res = answer(data, ++requests);
        if (res) bus.emit(BG_RESPONSE_CHANNEL, { schema_version: "pi-background-tasks.extension-response.v1", request_id: data.request_id, operation: "status", ...res });
      }
    },
    on: (ch: string, h: (d: unknown) => void) => {
      (subs[ch] ??= []).push(h);
      return () => void (subs[ch] = (subs[ch] ?? []).filter((x) => x !== h));
    },
  };
  const timers: (() => void)[] = [];
  const pi = { on: (n: string, h: any) => void (handlers[n] ??= []).push(h), events: bus } as any;
  const out: string[] = [];
  installBgRecords(pi, { env: { HERDR_PANE_ID: "p" }, platform: "linux", write: (d) => out.push(d), isTTY: true, setTimeout: (fn) => (timers.push(fn), timers.length), clearTimeout: () => undefined });
  return { handlers, out, timers, requests: () => requests };
}

test("bgrecords retry: ok:false at session_start, running task on the agent_start retry, written exactly once", async () => {
  const r = rig((_req, n) => (n === 1 ? { ok: false, error: { message: "unavailable before session_start" } } : { ok: true, result: { tasks: [{ id: "t1", name: "serve", status: "running" }] } }));
  await r.handlers.session_start[0]({ reason: "reload" }, { mode: "tui" });
  assert.deepEqual(r.out, []);
  await r.handlers.agent_start[0]({});
  assert.equal(r.out.length, 1);
  assert.match(r.out[0], /state=working:id=background-tasks\/t1:/);
  await r.handlers.agent_start[0]({});
  for (const t of r.timers) t();
  assert.equal(r.out.length, 1);
  assert.equal(r.requests(), 2, "no request after the first successful answer");
});

test("bgrecords retry: the timer is the last chance", async () => {
  const r = rig((_req, n) => (n < 3 ? { ok: false } : { ok: true, result: { tasks: [{ id: "t2", status: "running", command: "make" }] } }));
  await r.handlers.session_start[0]({ reason: "reload" }, { mode: "tui" });
  await r.handlers.agent_start[0]({});
  assert.deepEqual(r.out, []);
  r.timers[0]();
  assert.equal(r.out.length, 1);
  assert.match(r.out[0], /id=background-tasks\/t2:/);
});

test("bgrecords retry: an add-on that never answers gives no throw, no write", async () => {
  const r = rig(() => undefined);
  await r.handlers.session_start[0]({ reason: "reload" }, { mode: "tui" });
  await r.handlers.agent_start[0]({});
  await r.handlers.agent_start[0]({});
  for (const t of r.timers) t();
  assert.deepEqual(r.out, []);
  assert.equal(r.requests(), 3);
  await r.handlers.session_shutdown[0]({ reason: "quit" });
  assert.deepEqual(r.out, []);
});

test("bgrecords: win32 gets no SIGCONT handler, linux does", async () => {
  for (const [platform, expected] of [["win32", 0], ["linux", 1]] as const) {
    const before = process.listenerCount("SIGCONT");
    const handlers: Record<string, any[]> = {};
    const pi = { on: (n: string, h: any) => void (handlers[n] ??= []).push(h), events: undefined } as any;
    installBgRecords(pi, { env: { HERDR_PANE_ID: "p" }, platform, write: () => undefined, isTTY: true });
    await handlers.session_start[0]({ reason: "startup" }, { mode: "tui" });
    assert.equal(process.listenerCount("SIGCONT") - before, expected, platform);
    await handlers.session_shutdown[0]({ reason: "quit" });
    assert.equal(process.listenerCount("SIGCONT"), before);
  }
});
