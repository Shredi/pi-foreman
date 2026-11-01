// Misplaced `size`/`risk` (inside `options` or `args`) move to the top level of the launch before takeSizing strips them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liftSizing, takeSizing } from "../sizing.ts";
import { r11Rig } from "./_r11rig.ts";

const size = { files: ["a.ts"] };

test("liftSizing: options.size and options.risk move to the top level", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", options: { size, risk: ["guard"], other: 1 } };
  assert.deepEqual(liftSizing(input), { from: ["options"], left: false });
  assert.deepEqual(input, { agent: "builder", task: "t", options: { other: 1 }, size, risk: ["guard"] });
});

test("liftSizing: args move only when the launch names no workflow", () => {
  const plain: Record<string, unknown> = { agent: "builder", task: "t", args: { size } };
  assert.deepEqual(liftSizing(plain), { from: ["args"], left: false });
  assert.deepEqual(plain.size, size);
  assert.equal("args" in plain, false);
  const flow: Record<string, unknown> = { workflow: "w", args: { size } };
  assert.deepEqual(liftSizing(flow), { from: [], left: true });
  assert.deepEqual(flow.args, { size });
  assert.equal("size" in flow, false);
});

test("liftSizing: a top-level value wins over the misplaced one", () => {
  const input: Record<string, unknown> = { agent: "builder", size, options: { size: { files: ["b.ts"] } } };
  liftSizing(input);
  assert.deepEqual(input.size, size);
  assert.equal("options" in input, false);
});

test("liftSizing: args that keep another key stay, without the lifted fields", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", args: { size, other: 1 } };
  assert.deepEqual(liftSizing(input), { from: ["args"], left: false });
  assert.deepEqual(input.size, size);
  assert.deepEqual(input.args, { other: 1 });
});

test("liftSizing: a non-empty options stays as it is when nothing is lifted from it", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", options: { x: 1 }, args: { size } };
  liftSizing(input);
  assert.deepEqual(input.options, { x: 1 });
  assert.equal("args" in input, false);
});

test("liftSizing: tasks, chain and parallel entries lift their own options", () => {
  const a: Record<string, unknown> = { agent: "builder", task: "a", options: { risk: ["parser"] } };
  const b: Record<string, unknown> = { agent: "builder", task: "b", options: { size } };
  const input: Record<string, unknown> = { chain: [a, { parallel: [b] }] };
  assert.deepEqual(liftSizing(input), { from: ["options"], left: false });
  assert.deepEqual(a.risk, ["parser"]);
  assert.deepEqual(b.size, size);
  assert.equal(takeSizing(input).error, undefined);
  assert.equal("risk" in a, false);
});

test("liftSizing: nothing misplaced changes nothing", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", options: { x: 1 }, size };
  assert.deepEqual(liftSizing(input), { from: [], left: false });
  assert.deepEqual(input, { agent: "builder", task: "t", options: { x: 1 }, size });
});

test("adapter: a launch with size in options is lifted, sized and traced", async (t) => {
  const r = await r11Rig(t, { default: "standard" });
  const input: Record<string, unknown> = { agent: "builder", task: "build", options: { size, risk: ["guard"] } };
  const { res } = await r.launch(input);
  assert.equal(res, undefined);
  assert.equal("size" in input, false);
  assert.equal("options" in input, false);
  assert.deepEqual(r.events("sizing_lifted").map((e) => e.from), ["options"]);
  assert.equal(r.events("launch_sizing").length, 1);
});
