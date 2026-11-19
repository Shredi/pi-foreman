import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitRuntime } from "../wait.ts";
import { createBgRecords } from "../bgrecords.ts";

const LIMITS = { batchWindowSeconds: 300, maxSeconds: 100, maxActive: 8, ci: true };

function rig() {
  const out: string[] = [];
  createBgRecords({ write: (d) => out.push(d), env: { HERDR_PANE_ID: "p" }, mode: () => "tui", isTTY: true });
  const rt = new WaitRuntime({
    timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => LIMITS, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: () => undefined, trace: () => undefined,
  });
  return { rt, out };
}

// foreman_bg and its fb- records are gone: a pid wait is a plain wait and writes no sidebar record, on cancel and on close alike.
test("agent cancel and the close path of a pid wait write no record", () => {
  const r = rig();
  const s = r.rt.start({ kind: "pid", pid: 99, note: "plain" }) as { id: string };
  assert.equal(r.rt.cancel(s.id), true);
  r.rt.start({ kind: "pid", pid: 100, note: "plain2" });
  assert.equal(r.rt.cancelAll().length, 1);
  assert.equal(r.out.length, 0);
});
