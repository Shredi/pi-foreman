// D11: the facts behind the `supervisor_reply` trace (outcome of each reply, a re-delivered request after a reply).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPERVISOR_REQUEST_TYPE, SupervisorWindow } from "../supervisor.ts";
import { CustomSeen } from "../idlecustom.ts";
import { sanitizeTrace } from "../trace.ts";

const request = (id = "r1", runId = "run1") => ({ customType: SUPERVISOR_REQUEST_TYPE, details: { requestId: id, agent: "builder", runId } });
const live = () => true;
const dead = () => false;

test("replyOutcome: closed for a successful reply of an open request, without changing state", () => {
  const w = new SupervisorWindow();
  w.onMessage(request());
  assert.equal(w.replyOutcome({ replyTo: "r1" }, false, live), "closed");
  assert.equal(w.open.size, 1, "reading the outcome closes nothing");
  assert.ok(w.onSupervisorResult({ replyTo: "r1" }, false, live));
  assert.equal(w.open.size, 0);
});

test("replyOutcome: not_open without replyTo, for an unknown id and after the request was closed", () => {
  const w = new SupervisorWindow();
  w.onMessage(request());
  assert.equal(w.replyOutcome({}, false, live), "not_open");
  assert.equal(w.replyOutcome(undefined, false, live), "not_open");
  assert.equal(w.replyOutcome({ replyTo: "other" }, false, live), "not_open");
  w.onSupervisorResult({ replyTo: "r1" }, false, live);
  assert.equal(w.replyOutcome({ replyTo: "r1" }, false, live), "not_open");
});

test("replyOutcome: an errored reply keeps the window open for a live run and closes it for a dead one", () => {
  const w = new SupervisorWindow();
  w.onMessage(request());
  assert.equal(w.replyOutcome({ replyTo: "r1" }, true, live), "kept_error");
  assert.equal(w.onSupervisorResult({ replyTo: "r1" }, true, live), null);
  assert.equal(w.open.size, 1);
  assert.equal(w.replyOutcome({ replyTo: "r1" }, true, dead), "closed");
  assert.ok(w.onSupervisorResult({ replyTo: "r1" }, true, dead));
  assert.equal(w.open.size, 0);
});

test("a request id that a successful reply closed opens again when the message is delivered again (traced as reopened)", () => {
  const w = new SupervisorWindow();
  w.onMessage(request());
  assert.equal(w.wasReplied(request()), false);
  w.onSupervisorResult({ replyTo: "r1" }, false, live);
  assert.equal(w.wasReplied(request()), true);
  assert.equal(w.wasReplied(request("r2")), false);
  assert.ok(w.onMessage(request(), live), "the window itself still reopens: only the trace tells");
  assert.equal(w.open.size, 1);
});

test("an errored reply that closed a dead run's request is not a reply", () => {
  const w = new SupervisorWindow();
  w.onMessage(request());
  w.onSupervisorResult({ replyTo: "r1" }, true, dead);
  assert.equal(w.wasReplied(request()), false);
});

test("the replied set is capped", () => {
  const w = new SupervisorWindow();
  for (let i = 0; i < 100; i++) {
    w.onMessage(request(`r${i}`));
    w.onSupervisorResult({ replyTo: `r${i}` }, false, live);
  }
  assert.equal(w.wasReplied(request("r0")), false);
  assert.equal(w.wasReplied(request("r99")), true);
});

test("the idle path cannot deliver an answered request again: a custom entry followed by a message entry is not a trailing one", () => {
  const seen = new CustomSeen();
  const entry = { type: "custom_message", id: "e1", customType: SUPERVISOR_REQUEST_TYPE, content: "ask", details: request().details };
  assert.equal(seen.unseenTrailing([entry]).length, 1);
  assert.equal(seen.unseenTrailing([entry]).length, 0, "an entry already handled is skipped");
  const fresh = new CustomSeen();
  assert.equal(fresh.unseenTrailing([entry, { type: "message", id: "m1" }]).length, 0, "the reply turn's message entries end the trailing scan");
});

test("the trace record keeps replyTo, isError, role and outcome", () => {
  const rec = sanitizeTrace({ event: "supervisor_reply", replyTo: true, isError: false, outcome: "closed", role: "builder" });
  assert.deepEqual(rec, { event: "supervisor_reply", replyTo: true, isError: false, outcome: "closed", role: "builder" } as never);
});
