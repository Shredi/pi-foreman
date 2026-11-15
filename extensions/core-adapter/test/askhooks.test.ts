// ask_user_question bookkeeping as hooks on the tool name (askhooks.ts), on the result shape captured from the bundled
// @juicesharp/rpiv-ask-user-question 2.15.0 (fixtures/ask-user-question-2.15.0.json): no ruling-<n>.md for an open ask.md,
// the dialogs counter, and no ask_user_question registered by the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { askAnswered } from "../askhooks.ts";
import { ownerAnswered } from "../idlemodel.ts";
import { r11Rig } from "./_r11rig.ts";

const FIX = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ask-user-question-2.15.0.json"), "utf8"));
type R = { content: unknown; details: Record<string, unknown> };
const notes: R = FIX.answeredWithNotes;
const plain: R = FIX.answeredPlain;
const cancelled: R = FIX.cancelled;
const noUi: R = FIX.noUi;

type T = { after(fn: () => void | Promise<void>): void };

async function openRig(t: T) {
  const registered: string[] = [];
  const rig = await r11Rig(t, {}, { piExtra: { registerTool: (d: { name: string }) => void registered.push(d.name) } });
  const dir = rig.handoff("h1", "child");
  fs.writeFileSync(path.join(dir, "ask.md"), "# Ask 3: db choice\nWhich?\n");
  fs.writeFileSync(path.join(dir, ".ask"), "ask-3\n");
  return { rig, dir, registered };
}

const result = (rig: Awaited<ReturnType<typeof openRig>>["rig"], r: R, isError = false) => rig.fire("tool_result", { toolName: "ask_user_question", toolCallId: "a1", input: {}, content: r.content, details: r.details, isError });

test("askAnswered: answered with or without notes; not on cancel, no UI or an error", () => {
  assert.equal(askAnswered(notes.details, false), true);
  assert.equal(askAnswered(plain.details, false), true);
  assert.equal(askAnswered(cancelled.details, false), false);
  assert.equal(askAnswered(noUi.details, false), false);
  assert.equal(askAnswered(plain.details, true), false);
  assert.equal(askAnswered(undefined, false), false);
});

test("hooks: tool_result leaves details alone and writes no ruling, answered or Esc", async (t) => {
  const { rig, dir } = await openRig(t);
  const before = JSON.stringify(notes.details);
  const out = await result(rig, cancelled);
  assert.equal(out, undefined);
  assert.equal(fs.existsSync(path.join(dir, "ruling-3.md")), false);
  assert.equal(await result(rig, notes), undefined); // R2: no rewritten details
  assert.equal(JSON.stringify(notes.details), before);
  assert.equal(fs.existsSync(path.join(dir, "ruling-3.md")), false, "an answered dialog files no ruling-<n>.md");
});

test("hooks: tool_call counts one ask_user_question dialog; other tools are not counted", async (t) => {
  const { rig } = await openRig(t);
  const n = () => rig.events("dialog").filter((r) => r.surface === "ask_user").length;
  const n0 = n();
  await rig.call("ask_user_question", { questions: [] });
  assert.equal(n() - n0, 1);
  await rig.call("read", { path: "x" });
  assert.equal(n() - n0, 1);
});

test("the harness registers no ask_user_question tool", async (t) => {
  const { registered } = await openRig(t);
  assert.ok(registered.length > 0, "the rig sees the harness tools");
  assert.ok(!registered.includes("ask_user_question"), registered.join(","));
});

test("an answered owner dialog writes no ruling-<n>.md into any handoff dir, child side or parent side", async (t) => {
  const { rig, dir: asChild } = await openRig(t);
  const asParent = rig.handoff("kid", "parent");
  fs.writeFileSync(path.join(asParent, "ask.md"), "# Ask 2: other\n");
  fs.writeFileSync(path.join(asParent, ".ask"), "ask-2\n");
  for (const r of [plain, notes]) assert.equal(await result(rig, r), undefined);
  for (const dir of [asChild, asParent]) assert.deepEqual(fs.readdirSync(dir).filter((f) => /^ruling/.test(f)), [], dir);
});

test("ownerAnswered reads the package's shape next to the old decision", () => {
  assert.equal(ownerAnswered("ask_user_question", plain.details), true);
  assert.equal(ownerAnswered("ask_user_question", notes.details), true);
  assert.equal(ownerAnswered("ask_user_question", cancelled.details), false);
  assert.equal(ownerAnswered("ask_user_question", noUi.details), false);
  assert.equal(ownerAnswered("ask_user_question", plain.details, true), false);
  assert.equal(ownerAnswered("ask_user_question", {}), false);
  assert.equal(ownerAnswered("bash", plain.details), false);
});
