// D125: a plain intercom message from the parent closes the child's open ask (the parent badge); another sender or a cross-machine one does not.
// D130: a restart that ended an owner dialog asks again once at start (one appended custom message, no system text, no replay of an old answer).
// The real adapter over the r46 world.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { OPEN_DIALOG_MESSAGE_TYPE, dialogOf, openDialogFile } from "../opendialog.ts";

const ASK = "# Ask 1: which one?\n\nA or B?\n";

async function askRig(t: Parameters<typeof world>[0]) {
  const w = world(t, { ceremony: { default: "standard" }, handoff: true, parent: true });
  const a = await w.adapter();
  const file = path.join(w.handoff, "ask.md");
  let n = 0;
  const count = async (name: string) => (await w.traceEvents()).filter((e) => e.event === name && e.on === "parent" && e.kind === "parent-ask").length;
  const open = async () => {
    fs.writeFileSync(file, ASK);
    await a.fire("tool_result", { toolName: "write", toolCallId: `w${++n}`, input: { path: file }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
    assert.equal(await count("blocked_open"), 1, "the ask is open");
  };
  const message = (from: string, crossMachine?: boolean) => a.fire("message_end", { message: { role: "custom", customType: "intercom_message", details: { from: { id: from, name: "x" }, bodyText: "go with A", message: { crossMachine, content: { text: "go with A" } } }, content: "go with A" } });
  return { a, open, message, closed: () => count("blocked_closed") };
}

test("D125: another sender and a cross-machine sender leave the ask open; the parent's plain message closes it", async (t) => {
  const r = await askRig(t);
  await r.open();
  await r.message("someone-else");
  assert.equal(await r.closed(), 0, "another sender");
  await r.message("parent-session", true);
  assert.equal(await r.closed(), 0, "a sender on another machine");
  await r.message("parent-session");
  assert.equal(await r.closed(), 1, "the parent");
});

test("D130: a restart that ended a dialog appends ONE re-ask message at start; no replay at the next start; no answer, no system text", async (t) => {
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const w = world(t, { ceremony: { default: "standard" }, sent });
  const first = await w.adapter();
  const id = (first.ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
  await first.down();
  const agentDir = path.join(w.project, "..", "agent");
  const file = openDialogFile(agentDir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ v: 1, dialogs: [dialogOf("question", "Which?", { tool: "ask_user_question", questions: [{ question: "A or B?" }] }, new Date())] })}\n`);
  const asks = () => sent.filter((m) => m.message.customType === OPEN_DIALOG_MESSAGE_TYPE);
  const second = await w.adapter("resume");
  assert.equal(asks().length, 1);
  assert.match(asks()[0].message.content, /nothing earlier is replayed/);
  assert.match(asks()[0].message.content, /call ask_user_question again with the same questions/);
  assert.deepEqual(asks()[0].options, { triggerTurn: true });
  assert.equal(fs.existsSync(file), false, "the file is consumed");
  assert.equal(sent.some((m) => /system/i.test(m.message.customType)), false);
  await second.down();
  await w.adapter("resume");
  assert.equal(asks().length, 1, "no second re-ask");
});
