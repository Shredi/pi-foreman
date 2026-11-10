import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitRuntime, type ValidSpec } from "../wait.ts";
import { createBgRecords } from "../bgrecords.ts";

const LIMITS = { batchWindowSeconds: 300, maxSeconds: 100, maxActive: 8, ci: true };

function rig() {
  const out: string[] = [];
  const records = createBgRecords({ write: (d) => out.push(d), env: { HERDR_PANE_ID: "p" }, mode: () => "tui", isTTY: true });
  const hooks: string[] = [];
  const rt = new WaitRuntime({
    timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => LIMITS, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: () => undefined, trace: () => undefined,
    // the same mapping as index.ts
    onBgEnd: (id, note, how) => {
      hooks.push(how);
      if (how === "timeout") return;
      if (how === "dropped") records.clear(`fb-${id}`);
      else records.post(`fb-${id}`, "done", note, how === "exited" ? "Finished" : "Killed");
    },
  });
  return { rt, out, hooks, records };
}

const bgSpec: ValidSpec = { kind: "pid", pid: 4242, note: "build", log: "/x.log", bg: true };

test("agent cancel of a bg wait: hook dropped and the record is cleared, not done", () => {
  const r = rig();
  r.records.post("fb-w1", "working", "build", "Running");
  const s = r.rt.start(bgSpec) as { id: string };
  assert.equal(r.rt.cancel(s.id), true);
  assert.deepEqual(r.hooks, ["dropped"]);
  assert.match(r.out.at(-1)!, /state=clear:id=background-tasks\/fb-w1/);
  assert.equal(r.out.filter((d) => /state=done/.test(d)).length, 0);
});

test("close path (cancelAll): hook cancelled and a done Killed record", () => {
  const r = rig();
  r.records.post("fb-w1", "working", "build", "Running");
  r.rt.start(bgSpec);
  assert.deepEqual(r.rt.cancelAll(), ["w1"]);
  assert.deepEqual(r.hooks, ["cancelled"]);
  assert.match(r.out.at(-1)!, /state=done:id=background-tasks\/fb-w1:/);
  assert.match(r.out.at(-1)!, new RegExp(`msg=${Buffer.from("Killed").toString("base64")}`));
});

test("agent cancel of a non-bg wait: hook never called", () => {
  const r = rig();
  const s = r.rt.start({ kind: "pid", pid: 99, note: "plain" }) as { id: string };
  assert.equal(r.rt.cancel(s.id), true);
  assert.deepEqual(r.hooks, []);
  assert.equal(r.out.length, 0);
});
