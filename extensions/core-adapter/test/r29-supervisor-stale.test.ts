import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPERVISOR_REQUEST_TYPE, SupervisorWindow } from "../supervisor.ts";

// Ledger r29 item 6: a request re-injected after its run ended must not reopen the window.
const request = (requestId: string, runId: string) => ({ customType: SUPERVISOR_REQUEST_TYPE, details: { requestId, runId, agent: "builder" } });
const builderTools = () => ["read", "edit", "write"];
const onlyLive = (live: string) => (runId: string) => runId === live;

test("a request re-injected after its run ended opens nothing", () => {
  const w = new SupervisorWindow();
  const isLive = onlyLive("run-live");
  assert.deepEqual(w.staleRequest(request("q1", "run-ended"), isLive), { role: "builder", runId: "run-ended" });
  assert.equal(w.onMessage(request("q1", "run-ended"), isLive), null);
  assert.equal(w.open.size, 0);
  assert.equal(w.check("bash", { command: "ls" }, builderTools), undefined);
});

test("a live request still opens and blocks tools outside the role", () => {
  const w = new SupervisorWindow();
  const isLive = onlyLive("run-live");
  assert.equal(w.staleRequest(request("q2", "run-live"), isLive), null);
  assert.equal(w.onMessage(request("q2", "run-live"), isLive)?.requestId, "q2");
  assert.equal(w.open.size, 1);
  assert.match(w.check("bash", { command: "ls" }, builderTools)?.reason ?? "", /bash is not in the builder role's tools/);
});

test("a request without a run id is not judged stale", () => {
  const w = new SupervisorWindow();
  const message = { customType: SUPERVISOR_REQUEST_TYPE, details: { requestId: "q5", agent: "builder" } };
  assert.equal(w.staleRequest(message, () => false), null);
  assert.equal(w.onMessage(message, () => false)?.requestId, "q5");
});

test("a run end closes its open request", () => {
  const w = new SupervisorWindow();
  w.onMessage(request("q3", "run-live"));
  assert.equal(w.open.size, 1);
  assert.deepEqual(w.onRunEnd({ runId: "run-live" }), [{ role: "builder", runId: "run-live" }]);
  assert.equal(w.open.size, 0);
});

test("an errored reply closes its request only when the run is no longer live", () => {
  const w = new SupervisorWindow();
  w.onMessage(request("q4", "run-dead"));
  assert.equal(w.onSupervisorResult({ replyTo: "q4" }, true, () => true), null, "live run keeps the window");
  assert.equal(w.open.size, 1);
  assert.deepEqual(w.onSupervisorResult({ replyTo: "q4" }, true, () => false), { role: "builder", runId: "run-dead" });
  assert.equal(w.open.size, 0);
  assert.equal(w.check("bash", { command: "ls" }, builderTools), undefined);
});
