// A question still open at the turn end is released without an outcome. `Set.forEach` hands the callback (value, value, set), so passing
// `releaseQuestion` itself made the call id the `outcome`: a call id spelled like an outcome was then stored as the owner's answer.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { liveDir } from "../livestate.ts";

const CLOSED = "# Ledger: x\nTier: standard\n\n- [x] 1. item 1\n- [x] V. fresh-eyes verification passed\n";
const flush = () => new Promise((r) => setTimeout(r, 1300));

for (const end of ["agent_end", "turn_start"]) {
  test(`a question open at ${end} is released with no outcome, whatever its call id is`, async (t) => {
    const w = world(t, { ceremony: { default: "standard" } });
    const a = await w.adapter();
    await a.writeLedger(CLOSED);
    await a.ownerPrompt();
    const q = [{ header: "DB", question: "Which?", options: [{ label: "pg" }] }];
    await a.fire("tool_call", { toolName: "plan_mode_question", toolCallId: "answered", input: { questions: q } });
    await a.fire(end, { messages: [] });
    await flush();
    const dir = liveDir(path.join(w.project, "..", "agent"));
    const file = fs.readdirSync(dir).find((n) => n.endsWith(".json"));
    const live = JSON.parse(fs.readFileSync(path.join(dir, file!), "utf8")) as Record<string, unknown>;
    assert.equal("lastAnswer" in live, false, "the id is not an answer");
  });
}
