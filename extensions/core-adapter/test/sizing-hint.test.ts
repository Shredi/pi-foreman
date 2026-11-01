// The tool_result belt: a pi-subagents refusal caused by size/risk outside the top level gets the fix text appended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIX, misplacedHint } from "../sizing.ts";
import { r11Rig } from "./_r11rig.ts";

test("misplacedHint: the two upstream refusals match, other text does not", () => {
  assert.ok(misplacedHint("unknown options key 'size'")?.includes(FIX));
  assert.ok(misplacedHint("Error: unknown options key 'risk'.")?.includes("top-level keys"));
  assert.ok(misplacedHint("args requires workflow.")?.includes(FIX));
  assert.equal(misplacedHint("unknown options key 'foo'"), null);
  assert.equal(misplacedHint("launch failed"), null);
});

const text = (res: unknown): string => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

test("adapter: a launch that carried size in options and is refused upstream anyway gets the hint", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  const input: Record<string, unknown> = { agent: "builder", task: "t", options: { size: { files: ["a.ts"] } } };
  const { id } = await r.launch(input);
  const res = await r.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: {}, content: [{ type: "text", text: "unknown options key 'size'" }], isError: true });
  assert.match(text(res), /unknown options key 'size'/);
  assert.match(text(res), /top-level keys of the subagent call/);
  assert.equal(r.events("sizing_hint").length, 1);
});

test("adapter: the same refusal for a call without misplaced keys is left alone", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  const input: Record<string, unknown> = { agent: "builder", task: "t" };
  const { id } = await r.launch(input);
  const res = await r.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: {}, content: [{ type: "text", text: "args requires workflow." }], isError: true });
  assert.ok(!res || !/top-level keys/.test(text(res)));
  assert.equal(r.events("sizing_hint").length, 0);
});
