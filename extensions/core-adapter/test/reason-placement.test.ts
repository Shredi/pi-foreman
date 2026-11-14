// `reason` placement: a misplaced `reason` (options, or args without a workflow) moves to the top level like `size`/`risk`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liftSizing, misplacedHint, subagentDescription } from "../sizing.ts";
import { r11Rig } from "./_r11rig.ts";

test("liftSizing: options.reason moves to the top level; the top-level reason wins", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", options: { reason: "why", other: 1 } };
  assert.deepEqual(liftSizing(input), { from: ["options"], left: false });
  assert.deepEqual(input, { agent: "builder", task: "t", options: { other: 1 }, reason: "why" });
  const both: Record<string, unknown> = { agent: "builder", task: "t", reason: "top", options: { reason: "inner" } };
  liftSizing(both);
  assert.equal(both.reason, "top");
  assert.equal("options" in both, false);
});

test("liftSizing: args.reason moves without a workflow and stays with one; entries move their own", () => {
  const plain: Record<string, unknown> = { agent: "builder", task: "t", args: { reason: "why" } };
  assert.deepEqual(liftSizing(plain), { from: ["args"], left: false });
  assert.equal(plain.reason, "why");
  assert.equal("args" in plain, false);
  const flow: Record<string, unknown> = { workflow: "w", args: { reason: "why" } };
  assert.deepEqual(liftSizing(flow), { from: [], left: true });
  assert.deepEqual(flow.args, { reason: "why" });
  assert.equal("reason" in flow, false);
  const a: Record<string, unknown> = { agent: "builder", task: "a", options: { reason: "ra" } };
  liftSizing({ tasks: [a] });
  assert.equal(a.reason, "ra");
});

test("misplacedHint: a refusal naming reason says it is a top-level key", () => {
  assert.match(misplacedHint("unknown options key 'reason'. Valid options: acceptance") ?? "", /reason is a top-level key of the subagent call/);
  assert.equal(misplacedHint("unknown options key 'other'"), null);
});

test("the tool description patch names reason with size and risk", () => {
  const d = subagentDescription([{ name: "subagent", description: "Delegate." }], true) ?? "";
  assert.match(d, /`size: \{files[^`]*\}`, `risk: \[\.\.\.\]` and `reason`/);
});

test("adapter: options.reason with model strong reaches the ladder with the reason and is not refused", async (t) => {
  const roles = Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}`, ...(r === "builder" ? { strong: { model: "fake/builder-s" } } : {}) }]));
  const r = await r11Rig(t, {}, { config: { providers: { fake: { roles } } } });
  const input: Record<string, unknown> = { agent: "builder", task: "build", model: "strong", options: { reason: "the default model cannot do it" } };
  const { res } = await r.launch(input);
  assert.equal(res, undefined);
  assert.equal("options" in input, false);
  assert.equal("reason" in input, false);
  assert.equal(r.events("launch_refused").length, 0);
  assert.deepEqual(r.events("sizing_lifted").map((e) => e.from), ["options"]);
  assert.equal(String(input.model).split(":")[0], "fake/builder-s");
});
