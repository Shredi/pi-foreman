// R16 item 5: ask_user_question raises structured questions through ctx.ui, writes ruling-<n>.md for an open ask.md, and falls back to the ask.md path without a UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { askUserQuestion, OTHER_OPTION, parseQuestions } from "../askuser.ts";

const Q = { questions: [{ question: "Which db?", options: ["pg", "sqlite"] }, { question: "Ship?", options: ["yes", "no"], allowFreeText: false }] };

function stub(answers: Array<string | undefined>, inputs: Array<string | undefined> = []) {
  const calls: Array<{ title: string; options: string[] }> = [];
  return {
    calls,
    ui: {
      select: async (title: string, options: string[]) => (calls.push({ title, options }), answers.shift()),
      input: async () => inputs.shift(),
    },
  };
}

function handoff(open: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-r16-auq-"));
  fs.writeFileSync(path.join(dir, "ask.md"), "# Ask 3: db choice\nWhich?\n");
  if (open) fs.writeFileSync(path.join(dir, ".ask"), "ask-3\n");
  return dir;
}

test("parseQuestions: 1..4 questions, 2..4 options each", () => {
  assert.ok("error" in parseQuestions({ questions: [] }));
  assert.ok("error" in parseQuestions({ questions: Array(5).fill({ question: "q", options: ["a", "b"] }) }));
  assert.ok("error" in parseQuestions({ questions: [{ question: "q", options: ["a"] }] }));
  assert.ok("error" in parseQuestions({ questions: [{ question: "q", options: ["a", "b", "c", "d", "e"] }] }));
  assert.ok("questions" in parseQuestions(Q));
});

test("no UI: the owner-absent text (r79 item 5, no ask.md reference) and never calls ui", async () => {
  const s = stub([]);
  const r = await askUserQuestion(Q, { hasUI: false, ui: s.ui, ownDirs: () => [] });
  assert.equal(r.decision, "no_ui");
  assert.equal(r.text, "no human at this pane; the owner is absent. Decide with the information you have or report what needs an answer.");
  assert.doesNotMatch(r.text, /ask\.md/);
  assert.equal(s.calls.length, 0);
});

test("UI: options plus the free-text entry; free text goes through input; open ask writes ruling-<n>.md", async () => {
  const dir = handoff(true);
  const s = stub([OTHER_OPTION, "yes"], ["mariadb"]);
  const r = await askUserQuestion(Q, { hasUI: true, ui: s.ui, ownDirs: () => [dir] });
  assert.equal(r.decision, "answered");
  assert.deepEqual(s.calls[0].options, ["pg", "sqlite", OTHER_OPTION]);
  assert.deepEqual(s.calls[1].options, ["yes", "no"]);
  assert.match(r.text, /mariadb/);
  const ruling = fs.readFileSync(path.join(dir, "ruling-3.md"), "utf8");
  assert.match(ruling, /Answer: mariadb/);
  assert.match(ruling, /Answer: yes/);
  assert.equal(r.ruling, path.join(dir, "ruling-3.md"));
});

test("UI without an open ask.md: no ruling file; a dismissed dialog falls back to ask.md", async () => {
  const dir = handoff(false);
  const a = await askUserQuestion(Q, { hasUI: true, ui: stub(["pg", "no"]).ui, ownDirs: () => [dir] });
  assert.equal(a.decision, "answered");
  assert.equal(fs.existsSync(path.join(dir, "ruling-3.md")), false);
  const b = await askUserQuestion(Q, { hasUI: true, ui: stub([undefined]).ui, ownDirs: () => [dir] });
  assert.equal(b.decision, "dismissed");
  // r79 item 5: a dismissed question reads as the owner being absent
  assert.match(b.text, /the owner is absent/);
  assert.doesNotMatch(b.text, /ask\.md/);
});
