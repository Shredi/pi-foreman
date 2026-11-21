// D130 at the adapter: an answered or dismissed owner dialog stores `lastAnswer` in the live file and removes open-dialog.json; a dialog cut off by
// the shutdown keeps the file for the restart; the hold ends on an rpc owner input too. The real adapter over the r46 world.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { liveDir } from "../livestate.ts";

type World = ReturnType<typeof world>;
type Adapter = Awaited<ReturnType<World["adapter"]>>;

const agentOf = (w: World): string => path.join(w.project, "..", "agent");
const dialogFiles = (w: World): string[] => {
  const dir = path.join(agentOf(w), "pi-foreman", "state", "open-dialog");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
};
const live = (w: World): Record<string, unknown> => {
  const dir = liveDir(agentOf(w));
  const f = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  return JSON.parse(fs.readFileSync(path.join(dir, f[0]), "utf8")) as Record<string, unknown>;
};
const QUESTIONS = [{ header: "DB", question: "Which database?", options: [{ label: "pg" }, { label: "sqlite" }] }];
const open = (a: Adapter, id: string) => a.fire("tool_call", { toolName: "ask_user_question", toolCallId: id, input: { questions: QUESTIONS } });
const end = (a: Adapter, id: string, details: Record<string, unknown>) => a.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: id, result: { details }, isError: false });

async function start(t: Parameters<typeof world>[0]) {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.ownerPrompt();
  return { w, a };
}

test("an answered question: open-dialog.json while it is open, then removed and lastAnswer {question, answered} in the live file", async (t) => {
  const { w, a } = await start(t);
  assert.deepEqual(dialogFiles(w), []);
  await open(a, "q1");
  assert.equal(dialogFiles(w).length, 1, "the open dialog is stored");
  assert.equal("lastAnswer" in live(w), false);
  await end(a, "q1", { cancelled: false, answers: [{ question: "Which database?", answer: "pg" }] });
  assert.deepEqual(dialogFiles(w), [], "removed once the answer is stored");
  const last = live(w).lastAnswer as { kind: string; outcome: string };
  assert.deepEqual([last.kind, last.outcome], ["question", "answered"]);
});

test("a dismissed question stores outcome dismissed and removes the file", async (t) => {
  const { w, a } = await start(t);
  await open(a, "q1");
  await end(a, "q1", { cancelled: true, answers: [] });
  assert.deepEqual(dialogFiles(w), []);
  const last = live(w).lastAnswer as { kind: string; outcome: string };
  assert.deepEqual([last.kind, last.outcome], ["question", "dismissed"]);
});

test("a dialog that returns once the shutdown began (Pi cut it off) keeps open-dialog.json and stores no answer", async (t) => {
  const { w, a } = await start(t);
  await open(a, "q1");
  assert.equal(dialogFiles(w).length, 1);
  await a.fire("session_shutdown", {});
  await end(a, "q1", { cancelled: true, answers: [] });
  assert.equal(dialogFiles(w).length, 1, "the restart reads it and asks again");
  assert.equal("lastAnswer" in live(w), false, "a cut-off dialog is no answer");
});

test("the hold ends on an rpc owner input as on an interactive one", async (t) => {
  const { w, a } = await start(t);
  const hold = (params: Record<string, unknown>) => a.tool("foreman_hold")!.execute("h", params, undefined, undefined, a.ctx);
  await hold({ note: "the owner picks a model" });
  await a.fire("input", { source: "rpc", text: "go on" });
  const cleared = (await w.traceEvents()).filter((e) => e.event === "hold" && e.decision === "cleared");
  assert.deepEqual(cleared.map((e) => e.cause), ["owner_input"]);
});
