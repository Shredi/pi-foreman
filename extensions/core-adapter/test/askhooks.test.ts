// ask_user_question bookkeeping as hooks on the tool name (askhooks.ts), on the result shape captured from the bundled
// @juicesharp/rpiv-ask-user-question 2.15.0 (fixtures/ask-user-question-2.15.0.json): ruling-<n>.md for an open ask.md,
// the dialogs counter, and no ask_user_question registered by the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { askAnswered, writeAskRuling } from "../askhooks.ts";
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

test("writeAskRuling writes the answer text with its notes into ruling-<n>.md of an open ask, once", async (t) => {
  const { dir } = await openRig(t);
  const file = writeAskRuling([dir], notes.content, notes.details, false);
  assert.equal(file, path.join(dir, "ruling-3.md"));
  const text = fs.readFileSync(file!, "utf8");
  assert.match(text, /"Which database\?"="pg"\. user notes: keep it boring\./);
  assert.match(text, /global note: ship it Monday\./);
  assert.equal(writeAskRuling([dir], plain.content, plain.details, false), undefined); // wx: an existing ruling stays
});

test("writeAskRuling without notes writes the plain answer; nothing without an open ask", async (t) => {
  const { dir } = await openRig(t);
  assert.equal(writeAskRuling([path.join(dir, "missing")], plain.content, plain.details, false), undefined);
  const file = writeAskRuling([dir], plain.content, plain.details, false);
  const text = fs.readFileSync(file!, "utf8");
  assert.match(text, /"Which database\?"="pg"/);
  assert.doesNotMatch(text, /user notes:|global note:/);
});

test("writeAskRuling writes nothing for cancelled, no-UI and error results", async (t) => {
  const { dir } = await openRig(t);
  assert.equal(writeAskRuling([dir], cancelled.content, cancelled.details, false), undefined);
  assert.equal(writeAskRuling([dir], noUi.content, noUi.details, false), undefined);
  assert.equal(writeAskRuling([dir], plain.content, plain.details, true), undefined);
  assert.equal(fs.existsSync(path.join(dir, "ruling-3.md")), false);
});

test("hooks: tool_result writes the ruling and leaves details alone; Esc writes nothing", async (t) => {
  const { rig, dir } = await openRig(t);
  const before = JSON.stringify(notes.details);
  const out = await result(rig, cancelled);
  assert.equal(out, undefined);
  assert.equal(fs.existsSync(path.join(dir, "ruling-3.md")), false);
  assert.equal(await result(rig, notes), undefined); // R2: no rewritten details
  assert.equal(JSON.stringify(notes.details), before);
  assert.match(fs.readFileSync(path.join(dir, "ruling-3.md"), "utf8"), /user notes: keep it boring/);
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

test("ownerAnswered reads the package's shape next to the old decision", () => {
  assert.equal(ownerAnswered("ask_user_question", plain.details), true);
  assert.equal(ownerAnswered("ask_user_question", notes.details), true);
  assert.equal(ownerAnswered("ask_user_question", cancelled.details), false);
  assert.equal(ownerAnswered("ask_user_question", noUi.details), false);
  assert.equal(ownerAnswered("ask_user_question", plain.details, true), false);
  assert.equal(ownerAnswered("ask_user_question", {}), false);
  assert.equal(ownerAnswered("bash", plain.details), false);
});
