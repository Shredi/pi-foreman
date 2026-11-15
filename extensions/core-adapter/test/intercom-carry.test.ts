// PR 2 of the intercom round: the parent's question records and reminder (intercomcarry.ts, childblocked.ts), the answer-file predicate (ruling.ts)
// and the send/ownership matching. The child-side flag is in intercom-carry-flag.test.ts.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked, questionText } from "../childblocked.ts";
import { IntercomCarry, addresses, deliveredSendTo, firstLineOf, isQuestion, parentIdsOf, senderOf } from "../intercomcarry.ts";
import { answerNewerThan, isAnswerFile } from "../ruling.ts";
import { writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-15T08:00:00.000Z");

// The details pi-intercom gives an inbound message: the content starts with `**From …**`, the body is in `bodyText`.
const inbound = (text: string, id = "fm-job-1", name = "job") => ({
  from: { id, name },
  message: { content: { text } },
  bodyText: text,
});

function rig(seconds = 600) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-carry-")));
  let now = T0;
  let secs = seconds;
  const sent: { text: string; wake: boolean }[] = [];
  const traces: Record<string, unknown>[] = [];
  const carry = new IntercomCarry();
  const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => secs, carry, send: (text, wake) => sent.push({ text, wake }), trace: (r) => traces.push(r), now: () => now });
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "job");
  fs.mkdirSync(handoff, { recursive: true });
  const reg = (entry: Record<string, unknown> = {}) => writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open", ...entry }] });
  return { agentDir, handoff, carry, cb, sent, traces, reg, setSeconds: (n: number) => { secs = n; }, advance: (ms: number) => { now += ms; }, at: () => now, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

const stamp = (file: string, ms: number) => fs.utimesSync(file, new Date(ms), new Date(ms));
const put = (dir: string, name: string, text: string, ms?: number) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  if (ms !== undefined) stamp(f, ms);
  return f;
};

test("the first line comes from the message details, not from the content that starts with **From**", () => {
  const d = { from: { id: "x", name: "n" }, message: { content: { text: "**From n**\n\nQuestion: which?" } }, bodyText: "Question: which?\nmore" };
  assert.equal(firstLineOf(d), "Question: which?");
  assert.equal(isQuestion(d), true);
  // without bodyText the nested message content is the fallback; its `**From` heading is no question
  assert.equal(isQuestion({ from: { id: "x" }, message: { content: { text: "**From n**\n\nQuestion: which?" } } }), false);
  assert.equal(isQuestion(inbound("Question")), true);
  assert.equal(isQuestion(inbound("Questions about scope")), false, "the word, not a prefix of another word");
  assert.equal(isQuestion(inbound("question: lower case")), false);
  assert.equal(isQuestion(inbound("Plan from job: /x/plan.md")), false);
  assert.equal(isQuestion(inbound("Result from job: /x/result.md")), false);
  assert.equal(isQuestion(inbound("fyi\nQuestion: second line")), false, "the first line only");
  assert.equal(isQuestion(undefined), false);
  assert.deepEqual(senderOf(inbound("x")), { id: "fm-job-1", name: "job" });
  assert.equal(senderOf({}), null);
});

test("a send counts as delivered on details, on the text of a result without details, and on the broker mailbox; not on an error or another action", () => {
  const send = { action: "send", to: "fm-parent", message: "hi" };
  const ok = (extra: Record<string, unknown>) => deliveredSendTo({ toolName: "intercom", input: send, ...extra });
  assert.equal(ok({ details: { delivered: true }, content: [{ type: "text", text: "Message sent to fm-parent" }] }), "fm-parent");
  assert.equal(ok({ details: { delivered: true, delivery: "queued" }, content: [{ type: "text", text: "Message waiting in the broker mailbox" }] }), "fm-parent");
  assert.equal(ok({ details: {}, content: [{ type: "text", text: "Message sent to fm-parent" }] }), "fm-parent");
  assert.equal(ok({ details: {}, content: [{ type: "text", text: "Message is waiting in the broker mailbox for x" }] }), "fm-parent");
  assert.equal(ok({ details: { delivered: false }, content: [{ type: "text", text: "Message sent to fm-parent" }] }), undefined);
  assert.equal(ok({ details: { error: "Session not found" }, content: [{ type: "text", text: "Session not found" }] }), undefined);
  assert.equal(ok({ isError: true, details: {}, content: [{ type: "text", text: "Message sent to x" }] }), undefined);
  assert.equal(ok({ details: {}, content: [{ type: "text", text: "Session not found" }] }), undefined);
  assert.equal(deliveredSendTo({ toolName: "intercom", input: { action: "ask", to: "fm-parent", message: "x" }, details: { delivered: true } }), undefined);
  assert.equal(deliveredSendTo({ toolName: "intercom", input: { action: "list" }, details: {} }), undefined);
  assert.equal(deliveredSendTo({ toolName: "bash", input: send, details: { delivered: true } }), undefined);
});

test("a target addresses a session by id, by name (any case) and by an id prefix of four characters or more", () => {
  assert.equal(addresses("fm-parent-1", "fm-parent-1"), true);
  assert.equal(addresses("Main", "fm-parent-1", ["main"]), true);
  assert.equal(addresses("fm-p", "fm-parent-1"), true);
  assert.equal(addresses("fm-", "fm-parent-1"), false, "a prefix shorter than four characters");
  assert.equal(addresses("other", "fm-parent-1", ["main"]), false);
  assert.equal(addresses("", "fm-parent-1"), false);
});

test("the parent id is read from the handoff `parent` file each time; no file or an empty one gives none", (t) => {
  const r = rig();
  t.after(r.cleanup);
  assert.deepEqual(parentIdsOf([r.handoff]), []);
  put(r.handoff, "parent", "fm-a\n");
  assert.deepEqual(parentIdsOf([r.handoff]), ["fm-a"]);
  put(r.handoff, "parent", "fm-b\n");
  assert.deepEqual(parentIdsOf([r.handoff]), ["fm-b"], "the parent can change");
  put(r.handoff, "parent", "\n");
  assert.deepEqual(parentIdsOf([r.handoff]), []);
  assert.deepEqual(parentIdsOf([]), [], "no handoff dir: no parent");
});

test("answer files: brief-<n>.md and ruling-<n>.md count; ruling.md, ruling-plan.md, steer-<n>.md and a brief equal to a plan ruling do not", (t) => {
  const r = rig();
  t.after(r.cleanup);
  const d = r.handoff;
  put(d, "ruling-1.md", "x");
  put(d, "brief-1.md", "an answer");
  assert.equal(isAnswerFile(d, "ruling-1.md"), true);
  assert.equal(isAnswerFile(d, "brief-1.md"), true);
  put(d, "ruling.md", "APPROVED\nplan");
  put(d, "ruling-plan.md", "APPROVED\nother plan");
  put(d, "steer-1.md", "steer");
  assert.equal(isAnswerFile(d, "ruling.md"), false);
  assert.equal(isAnswerFile(d, "ruling-plan.md"), false);
  assert.equal(isAnswerFile(d, "ruling-0.md"), false);
  assert.equal(isAnswerFile(d, "steer-1.md"), false);
  assert.equal(isAnswerFile(d, "ask.md"), false);
  put(d, "brief-2.md", "APPROVED\nplan");
  assert.equal(isAnswerFile(d, "brief-2.md"), false, "byte-equal to ruling.md");
  put(d, "brief-3.md", "APPROVED\nother plan");
  assert.equal(isAnswerFile(d, "brief-3.md"), false, "byte-equal to ruling-plan.md");
  put(d, "brief-4.md", "APPROVED\nplan and one more line");
  assert.equal(isAnswerFile(d, "brief-4.md"), true, "a different brief is an answer");
});

test("answerNewerThan: an answer file newer than the time counts, an older one does not, a plan ruling or its brief copy or a steer never", (t) => {
  const r = rig();
  t.after(r.cleanup);
  const d = r.handoff;
  put(d, "brief-1.md", "old answer", T0 - MIN);
  assert.equal(answerNewerThan(d, T0), false, "older than the record");
  put(d, "ruling.md", "APPROVED", T0 + MIN);
  put(d, "ruling-plan.md", "APPROVED p", T0 + MIN);
  put(d, "brief-2.md", "APPROVED", T0 + MIN);
  put(d, "steer-1.md", "steer", T0 + MIN);
  assert.equal(answerNewerThan(d, T0), false, "plan ruling, its brief copy and a steer");
  put(d, "ruling-1.md", "a ruling", T0 + MIN);
  assert.equal(answerNewerThan(d, T0), true);
  assert.equal(answerNewerThan(path.join(d, "missing"), T0), false);
});

test("a record: one per child, the older time kept, label and time only", () => {
  const c = new IntercomCarry();
  c.note("fm-job-1", "job", 100);
  c.note("fm-job-1", "job", 200);
  c.note("fm-other", "other", 300);
  assert.equal(c.records.size, 2);
  assert.equal(c.records.get("fm-job-1")?.at, 100);
  assert.deepEqual(Object.keys(c.records.get("fm-job-1")!).sort(), ["at", "child", "label", "reminded"], "no text field");
});

test("the parent's send to a child removes its record: by id, by name, by label; not a send to another session", () => {
  const c = new IntercomCarry();
  c.note("fm-job-1", "job", 1);
  c.note("fm-two-2", "two", 1);
  c.note("fm-three-3", "three", 1);
  c.answered("somebody-else");
  assert.equal(c.records.size, 3);
  c.answered("fm-job-1");
  assert.equal(c.records.has("fm-job-1"), false, "by id");
  c.seen(inbound("Question: x", "fm-two-2", "Worker-Two"));
  c.answered("worker-two");
  assert.equal(c.records.has("fm-two-2"), false, "by the name the child used");
  c.answered("THREE");
  assert.equal(c.records.has("fm-three-3"), false, "by the registry label");
});

test("reminder: nothing before the seconds, one at them with label and age only, never again", (t) => {
  const r = rig(600);
  t.after(r.cleanup);
  r.reg();
  r.carry.note("fm-job-1", "job", r.at());
  r.advance(9 * MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 0, "below the delay");
  r.advance(MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].wake, true, "starts a turn in an idle parent (the send dependency queues it while a run is going)");
  assert.equal(r.sent[0].text, questionText("job", 10 * MIN));
  assert.match(r.sent[0].text, /^Child session job has waited 10 min for your answer to its question\./);
  for (let i = 0; i < 60; i++) {
    r.advance(MIN);
    r.cb.tick();
  }
  assert.equal(r.sent.length, 1, "once per record");
  assert.deepEqual(r.traces.map((x) => x.event), ["child_question_reminder"]);
  assert.equal(r.traces[0].label, "job");
  assert.equal(typeof r.traces[0].waitedMs, "number");
  // a new record of the same child, after the first was answered, is reminded on its own
  r.carry.answered("fm-job-1");
  r.carry.note("fm-job-1", "job", r.at());
  r.advance(10 * MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 2);
});

test("reminder: 0 turns it off; it never carries a word the child wrote", (t) => {
  const r = rig(0);
  t.after(r.cleanup);
  r.reg();
  r.carry.note("fm-job-1", "job", r.at());
  r.advance(24 * 60 * MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 0, "0 = off");
  r.setSeconds(600);
  r.cb.tick();
  assert.equal(r.sent.length, 1, "the record is still there when the setting is on again");
  assert.doesNotMatch(r.sent[0].text, /Question|which|\*\*From/);
});

test("reminder: not after the parent's send removed the record", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg();
  r.carry.note("fm-job-1", "job", r.at());
  r.advance(5 * MIN);
  r.carry.answered("fm-job-1");
  r.advance(20 * MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 0);
});

test("reminder: an answer file newer than the record drops it; an older file, a plan ruling and its brief copy do not", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg();
  put(r.handoff, "brief-1.md", "old answer", r.at() - MIN);
  r.carry.note("fm-job-1", "job", r.at());
  put(r.handoff, "ruling.md", "APPROVED", r.at() + MIN);
  put(r.handoff, "brief-2.md", "APPROVED", r.at() + MIN);
  put(r.handoff, "steer-1.md", "steer", r.at() + MIN);
  r.advance(10 * MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 1, "none of those answers the question: it is reminded");

  const r2 = rig();
  t.after(r2.cleanup);
  r2.reg();
  r2.carry.note("fm-job-1", "job", r2.at());
  put(r2.handoff, "brief-1.md", "the answer", r2.at() + MIN);
  r2.advance(10 * MIN);
  r2.cb.tick();
  assert.equal(r2.sent.length, 0, "a newer brief answers it");
  assert.equal(r2.carry.records.size, 0);

  const r3 = rig();
  t.after(r3.cleanup);
  r3.reg();
  r3.carry.note("fm-job-1", "job", r3.at());
  put(r3.handoff, "ruling-1.md", "the answer", r3.at() + MIN);
  r3.advance(10 * MIN);
  r3.cb.tick();
  assert.equal(r3.sent.length, 0, "a newer ruling-<n>.md answers it");
});

test("reminder: the record goes when the child's registry entry closes or is gone", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ status: "closed" });
  r.carry.note("fm-job-1", "job", r.at());
  r.advance(30 * MIN);
  r.cb.tick();
  assert.equal(r.sent.length, 0);
  assert.equal(r.carry.records.size, 0);
  const r2 = rig();
  t.after(r2.cleanup);
  writeRegistry(r2.agentDir, { version: 1, sessions: [] });
  r2.carry.note("fm-job-1", "job", r2.at());
  r2.cb.tick();
  assert.equal(r2.carry.records.size, 0, "no entry");
});

test("a question starts no blocked state: the pass emits nothing but the reminder, and sends no live-file or herdr trace", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg();
  r.carry.note("fm-job-1", "job", r.at());
  r.advance(11 * MIN);
  r.cb.tick();
  assert.deepEqual(r.traces.map((x) => x.event), ["child_question_reminder"]);
  assert.equal(fs.existsSync(path.join(r.agentDir, "pi-foreman", "live")), false, "no live file is written");
});
