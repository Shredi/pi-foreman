// R16 item 5: ask_user_question answers only an open ask.md of a handoff dir where the session is the child (childHandoffDirs); a dir it opened as parent is never answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { askUserQuestion } from "../askuser.ts";
import { childHandoffDirs } from "../owned.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const Q = { questions: [{ question: "Which db?", options: ["pg", "sqlite"] }] };
const ui = { select: async () => "pg", input: async () => undefined };

function handoff(root: string, name: string, side: "parent" | "child", id: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, side), `${id}\n`);
  fs.writeFileSync(path.join(dir, "ask.md"), "# Ask 2: db choice\nWhich?\n");
  fs.writeFileSync(path.join(dir, ".ask"), "ask-2\n");
  return dir;
}

test("an open ask in a dir where the session is the parent is never answered", async () => {
  const root = mkTestTmp("pf-r16-auqd-");
  try {
    const asChild = handoff(root, "own", "child", "me");
    const asParent = handoff(root, "kid", "parent", "me");
    const r = await askUserQuestion(Q, { hasUI: true, ui, ownDirs: () => childHandoffDirs(root, "me") });
    assert.equal(r.decision, "answered");
    assert.equal(fs.existsSync(path.join(asParent, "ruling-2.md")), false);
    assert.equal(fs.existsSync(path.join(asChild, "ruling-2.md")), true);
    // only the parent-side dir is open: no ruling is written at all
    fs.rmSync(path.join(asChild, "ruling-2.md"));
    fs.rmSync(path.join(asChild, ".ask"));
    const r2 = await askUserQuestion(Q, { hasUI: true, ui, ownDirs: () => childHandoffDirs(root, "me") });
    assert.equal(r2.ruling, undefined);
    assert.equal(fs.existsSync(path.join(asParent, "ruling-2.md")), false);
  } finally {
    rmTestTmp(root);
  }
});
