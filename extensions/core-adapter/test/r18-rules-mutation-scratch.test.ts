// R18 item 5 (F11): the shipped reviewer rules allow mutation tests confined to the session's own scratch dir; the line reaches the
// reviewer prompt of an overlay ask whose command is such a mutation test (stubbed reviewer, as in r16-rules-prompt).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RULES = fs.readFileSync(path.join(PKG, "config", "permissions.rules.md"), "utf8");
const LINE = "mutation tests confined to the session's own scratch dir";
const CMD = "cp -r src $FOREMAN_SCRATCH/m && cd $FOREMAN_SCRATCH/m && npm test";

test("rules file: the $FOREMAN_SCRATCH line carries the mutation-test clause once", () => {
  assert.equal(RULES.split(LINE).length, 2);
  const line = RULES.split("\n").find((l) => l.includes("$FOREMAN_SCRATCH"))!;
  assert.ok(line.includes(LINE));
});

test("overlay review: a mutation test confined to $FOREMAN_SCRATCH reaches the stubbed reviewer with the extended rule and is allowed", async () => {
  let system = "";
  let request = "";
  const reg: RegistryLike = {
    find: () => ({}),
    complete: async (_m, c) => {
      const ctx = c as unknown as { systemPrompt: string; messages: { content: string }[] };
      system = ctx.systemPrompt;
      request = ctx.messages[0].content;
      return { content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" };
    },
  };
  const r = new ForemanReview();
  r.upsert("s", { isChild: false, cwd: "/w", provider: "a", config: () => ({ providers: { a: { review: { model: "a/small" } } } }), registry: reg, intent: "" });
  const out = await r.reviewOverlayAsk("s", { surface: "bash", tool: "bash", value: CMD, session: "s" }, RULES);
  assert.equal(out.verdict.kind, "allow");
  assert.ok(system.includes(LINE));
  assert.ok(request.includes(CMD));
});
