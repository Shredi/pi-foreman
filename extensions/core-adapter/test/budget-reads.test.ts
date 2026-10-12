import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadCall, ReadBudget, readLimits } from "../budget.ts";
import { SupervisorWindow, SUPERVISOR_REQUEST_TYPE } from "../supervisor.ts";

const L = readLimits({ before: { warn: 2, deny: 3 }, after: { warn: 1, deny: 2 } });

test("isReadCall: READ_CLASS names, mcp__*, subagent get|guide only", () => {
  assert.ok(isReadCall("read", {}));
  assert.ok(isReadCall("bash", {}));
  assert.ok(isReadCall("mcp__fake__probe", { path: "x" }));
  assert.ok(isReadCall("subagent", { action: "get" }));
  assert.ok(isReadCall("subagent", { action: "guide" }));
  assert.ok(!isReadCall("subagent", { action: "status" }));
  assert.ok(!isReadCall("subagent", { agent: "builder", task: "x" }));
  assert.ok(!isReadCall("subagent", undefined));
  assert.ok(!isReadCall("edit", {}));
});

test("mcp and subagent get calls count against the budget under the name read", () => {
  const b = new ReadBudget();
  const calls: [string, unknown][] = [["mcp__fake__probe", {}], ["subagent", { action: "get" }], ["subagent", { action: "guide" }], ["mcp__fake__probe", {}]];
  const kinds = calls.map(([n, i], k) => (isReadCall(n, i) ? b.check("read", `c${k}`, L, 3, false).kind : "skipped"));
  assert.deepEqual(kinds, ["allow", "warn", "warn", "deny"]);
});

test("supervisor window closes at the reply and at run end, then reads count", () => {
  for (const close of ["reply", "runEnd"]) {
    const w = new SupervisorWindow();
    const b = new ReadBudget();
    w.onMessage({ customType: SUPERVISOR_REQUEST_TYPE, details: { requestId: "r1", agent: "builder", runId: "run1" } });
    assert.equal(w.open.size, 1);
    assert.equal(b.check("read", "a", L, 3, w.open.size > 0).kind, "allow");
    assert.equal(b.check("read", "b", L, 3, w.open.size > 0).kind, "allow");
    assert.equal(b.check("read", "c", L, 3, w.open.size > 0).kind, "allow");
    if (close === "reply") assert.ok(w.onSupervisorResult({ replyTo: "r1" }, false));
    else assert.equal(w.onRunEnd({ runId: "run1" }).length, 1);
    assert.equal(w.open.size, 0);
    assert.equal(b.check("read", "d", L, 3, w.open.size > 0).kind, "allow");
    assert.equal(b.check("read", "e", L, 3, w.open.size > 0).kind, "warn");
  }
});
