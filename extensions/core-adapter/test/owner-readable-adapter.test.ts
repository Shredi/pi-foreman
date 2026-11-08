// Owner-readable wiring in the adapter: the checkpoint dialog shows the owner section first (warning when missing),
// the plan-review launch carries the owner facts, ask_user_question gets a project prefix (idempotent, label only in a child session)
// and a jargon hint on its result, foreman_show hints at a missing opening summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { world } from "./_r46world.ts";

const WITH = "# Widget\n\n## For the owner\nWe ship the widget.\nIt takes one builder.\n\n## Goal\nShip it.\n";

test("checkpoint dialog: the owner section comes before the plan summary", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, WITH);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  await a.checkpoint();
  const n = w.notes.find((m) => /Plan: Widget/.test(m))!;
  assert.ok(n, "the summary note exists");
  assert.ok(n.startsWith("For the owner\n  We ship the widget."), n);
  assert.ok(n.indexOf("For the owner") < n.indexOf("Plan: Widget"));
});

test("checkpoint dialog: a plan without the section gets the warning line first and is not refused", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  const r = await a.checkpoint();
  assert.equal(r.decision, "approve");
  const n = w.notes.find((m) => /Plan: Widget/.test(m))!;
  assert.ok(n.startsWith('⚠ No "For the owner" summary'), n);
});

test("ask_user_question: project prefix once, hint on a jargon result, main session has no label", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const input = { questions: [{ question: "Change `index.ts`?", header: "Q", options: [{ label: "Yes", description: "ok" }, { label: "No", description: "no" }] }] };
  const first = await a.call("ask_user_question", input);
  assert.match(input.questions[0].question, /^\[[^\]·]+\] Change/);
  assert.ok(!input.questions[0].question.includes("·"), "no session label in a main session");
  assert.match(first.note, /reads like jargon/);
  const before = input.questions[0].question;
  await a.call("ask_user_question", input);
  assert.equal(input.questions[0].question, before, "idempotent");
  const plain = { questions: [{ question: "Should the page load faster?", header: "Q", options: [{ label: "Yes", description: "faster" }, { label: "No", description: "slower" }] }] };
  assert.equal((await a.call("ask_user_question", plain)).note, "");
});

test("ask_user_question in an opened session carries the session label", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  const input = { questions: [{ question: "Which way?", header: "Q", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] };
  await a.call("ask_user_question", input);
  assert.match(input.questions[0].question, /^\[[^\]]+\] Which way\?$/);
});

test("foreman_show: a hint when the note opens with a table, none for a plain opening", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const show = a.tool("foreman_show");
  if (!show) return; // the panel tool is not registered in this rig
  const run = async (markdown: string) => ((await show.execute("s", { title: "T", markdown }, undefined, undefined, a.ctx)) as { content: { text: string }[] }).content[0].text;
  assert.match(await run("| a | b |\n|---|---|\n"), /plain 2-3 sentence/);
  assert.doesNotMatch(await run("This is about caching. It keeps pages fast.\n\n| a |\n"), /plain 2-3 sentence/);
});
