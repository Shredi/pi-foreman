// Item 1 of workflow-waste: the write or edit result of a plan whose Summary form passes carries one advice line (a ready explorer task for the
// code-claims check) before the first [plan-review] of its lineage; once per plan path, never a refusal, tool result only, off with planReview off.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { claimsHintLine } from "../planreview.ts";
import { world } from "./_r46world.ts";

const GOOD = "# Widget\n\n## Summary\n\n**Goal:** ship the widget.\n\n1. Do one thing.\n\n## Goal\nShip it.\n";
const GOOD2 = `${GOOD}\nMore text.\n`;
const BAD = "# Widget\n\n## Goal\nShip it.\n";
const ON = { planReview: { heavy: true } };
const HINT = /advice: before the first \[plan-review\] have an inexpensive explorer check/;

async function rig(t: Parameters<typeof world>[0], ceremony: Record<string, unknown> = ON) {
  const w = world(t, { ceremony });
  const a = await w.adapter("startup");
  const write = async (text: string): Promise<string> => {
    fs.writeFileSync(w.planFile, text);
    return (await a.call("write", { path: w.planFile, content: text })).note;
  };
  return { w, a, write };
}

test("the first valid write of a plan carries the line with the path and a ready explorer task", async (t) => {
  const { w, write } = await rig(t);
  const note = await write(GOOD);
  assert.match(note, HINT);
  assert.ok(note.includes(fs.realpathSync.native(w.planFile)), "names the plan path");
  assert.ok(note.includes(claimsHintLine(fs.realpathSync.native(w.planFile))));
  assert.match(note, /Explorer task: "Read .*plan-widget\.md\. List every claim it makes about code .*Report claims that are wrong, unverifiable or unread\."/);
  assert.match(note, /never blocks a review/);
});

test("a second write before any review gets no line", async (t) => {
  const { write } = await rig(t);
  assert.match(await write(GOOD), HINT);
  assert.doesNotMatch(await write(GOOD2), HINT);
});

test("a write that fails the Summary form gets no line, and the later valid write does", async (t) => {
  const { write } = await rig(t);
  const bad = await write(BAD);
  assert.match(bad, /plan form is wrong/);
  assert.doesNotMatch(bad, HINT);
  assert.match(await write(GOOD), HINT);
});

test("a lineage with a verdict gets no line, also after a reload that restores it", async (t) => {
  const { w, a, write } = await rig(t);
  fs.writeFileSync(w.planFile, GOOD);
  assert.equal(await a.review("FAIL"), null);
  assert.doesNotMatch(await write(GOOD2), HINT, "revised version after a FAIL");
  await a.down();
  const b = await w.adapter("resume");
  fs.writeFileSync(w.planFile, `${GOOD2}\nand more.\n`);
  const note = (await b.call("write", { path: w.planFile, content: "x" })).note;
  assert.doesNotMatch(note, HINT, "restored verdict");
});

test("the line is in the tool result, never in the system prompt", async (t) => {
  const { write, a } = await rig(t);
  assert.match(await write(GOOD), HINT);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await a.fire("before_agent_start", event);
  const text = JSON.stringify(event.systemPromptOptions.sections);
  assert.doesNotMatch(text, /Explorer task|claims about the code/);
});

test("ceremony.planReview off gives no line", async (t) => {
  const { write } = await rig(t, { planReview: { heavy: false } });
  assert.doesNotMatch(await write(GOOD), HINT);
});
