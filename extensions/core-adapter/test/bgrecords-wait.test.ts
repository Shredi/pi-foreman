import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitRuntime, type ValidSpec } from "../wait.ts";
import { createBgRecords } from "../bgrecords.ts";

const LIMITS = { batchWindowSeconds: 300, maxSeconds: 100, maxActive: 8, ci: true };

function rig(alive: () => boolean) {
  let now = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const timers = {
    set: (fn: () => void, ms: number) => (due.set(++seq, { at: now + ms, fn }), seq),
    clear: (h: unknown) => void due.delete(h as number),
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const [id, t] = [...due.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined) break;
      due.delete(id);
      now = t!.at;
      t!.fn();
    }
    now = end;
  };
  const out: string[] = [];
  const records = createBgRecords({ write: (d) => out.push(d), env: { HERDR_PANE_ID: "p" }, mode: () => "tui", isTTY: true });
  const hooks: string[] = [];
  const rt = new WaitRuntime({
    timers, now: () => now, limits: () => LIMITS, stat: () => null, alive, gh: () => Promise.reject(new Error("unused")), wake: () => undefined, trace: () => undefined,
    // the same mapping as index.ts
    onBgEnd: (id, note, how) => {
      hooks.push(how);
      if (how !== "timeout") records.post(`fb-${id}`, "done", note, how === "exited" ? "Finished" : "Killed");
    },
  });
  return { rt, advance, out, hooks, records };
}

const bgSpec = (pid = 4242): ValidSpec => ({ kind: "pid", pid, note: "build", log: "/x.log", bg: true });

test("bg wait: process exit gives hook exited and a done record", () => {
  let up = true;
  const r = rig(() => up);
  r.records.post("fb-w1", "working", "build", "Running");
  assert.ok("id" in r.rt.start(bgSpec()));
  up = false;
  r.advance(60_000);
  assert.deepEqual(r.hooks, ["exited"]);
  assert.match(r.out.at(-1)!, /state=done:id=background-tasks\/fb-w1:/);
});

test("bg wait: cancelAll (close) gives hook cancelled and a done record", () => {
  const r = rig(() => true);
  r.rt.start(bgSpec());
  assert.deepEqual(r.rt.cancelAll(), ["w1"]);
  assert.deepEqual(r.hooks, ["cancelled"]);
  assert.match(r.out.at(-1)!, /state=done:id=background-tasks\/fb-w1:/);
});

test("bg wait: timeout with the process alive gives hook timeout and the record stays working", () => {
  const r = rig(() => true);
  r.records.post("fb-w1", "working", "build", "Running");
  r.rt.start(bgSpec());
  r.advance(101_000);
  assert.deepEqual(r.hooks, ["timeout"]);
  assert.equal(r.out.length, 1);
  assert.match(r.out[0], /state=working/);
});

test("bg wait: timeout with the process gone is exited", () => {
  const r = rig(() => false);
  r.rt.start(bgSpec());
  r.rt.resolve("w1", "timeout");
  assert.deepEqual(r.hooks, ["exited"]);
});

test("bg wait: a non-bg pid wait never calls the hook", () => {
  let up = true;
  const r = rig(() => up);
  const s = r.rt.start({ kind: "pid", pid: 77, note: "other" }) as { id: string };
  up = false;
  r.advance(60_000);
  const t = r.rt.start({ kind: "pid", pid: 78, note: "other2" }) as { id: string };
  r.rt.cancel(t.id);
  assert.ok(s.id);
  assert.deepEqual(r.hooks, []);
});
