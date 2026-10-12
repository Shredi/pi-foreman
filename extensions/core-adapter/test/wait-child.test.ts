import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStart, WaitRuntime, wakeMessage } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const LIMITS: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };
const bound = { cwd: "/ws", home: "/h", agentDir: "/a", platform: process.platform, overlay: null };

function runtime() {
  const wakes: Outcome[][] = [];
  const timers: Timers = { set: () => 1, clear: () => undefined };
  const rt = new WaitRuntime({ timers, now: () => 0, limits: () => LIMITS, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: () => undefined });
  return { rt, wakes };
}

test("wait child: parse needs a label", () => {
  assert.deepEqual(parseStart({ kind: "child", label: "phase1", note: "n" }, LIMITS, bound), { kind: "child", label: "phase1", note: "n" });
  assert.deepEqual(parseStart({ kind: "child", label: "any" }, LIMITS, bound), { kind: "child", label: "any", note: "" });
  for (const bad of [{}, { label: "" }, { label: "a b" }, { label: 3 }]) assert.ok("error" in parseStart({ kind: "child", ...bad }, LIMITS, bound), JSON.stringify(bad));
});

test("wait child: a notice for the label resolves the wait with the wake line", () => {
  const { rt, wakes } = runtime();
  assert.ok("id" in rt.start({ kind: "child", label: "phase1", note: "p1" }));
  assert.equal(rt.childNotice("other", "plan", "/h/plan.md"), false);
  assert.equal(rt.active, 1);
  assert.equal(rt.childNotice("phase1", "plan", "/h/plan.md"), true);
  assert.equal(rt.active, 0);
  assert.equal(wakes[0][0].outcome, "child phase1: plan /h/plan.md");
  assert.match(wakeMessage(wakes[0]).content, /\(child\) "p1": child phase1: plan \/h\/plan\.md$/);
  assert.equal(rt.childNotice("phase1", "result", "/h/result.md"), false, "a notice with no wait is not replayed");
});

test("wait child: label any takes the next notice of any child; a named wait wins", () => {
  const { rt, wakes } = runtime();
  rt.start({ kind: "child", label: "any", note: "" });
  rt.start({ kind: "child", label: "b", note: "" });
  assert.equal(rt.childNotice("b", "result", "/r.md"), true);
  assert.equal(wakes[0][0].note, "");
  assert.equal(wakes[0][0].id, "w2");
  assert.equal(rt.childNotice("zed", "closed", "/c.md"), true);
  assert.equal(wakes[1][0].outcome, "child zed: closed /c.md");
  assert.equal(rt.active, 0);
});
