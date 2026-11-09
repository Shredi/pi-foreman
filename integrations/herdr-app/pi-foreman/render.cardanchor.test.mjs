import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { sess, treeOf } = await import("./fixtures.mjs");

function render(mod) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  return mod.render({});
}
const newMod = (root) => {
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [root], openPrs: [], tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  return mod;
};
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const cards = (el) => walk(el).filter((e) => e.kind === "HoverCard");
const dot = (n, state) => ({ n, state, label: `#${n}`, src: "pr", name: "ci" });
const root = () => treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", dots: [dot(16, "fail")] }, []));
const move = (y) => ({ position: { x: 200, y }, local_position: { x: 10, y: 9 }, bounds: { x: 0, y: 0, width: 60, height: 18 } });

test("the chip carries a tooltip with the state text and stays the click target under a card with a show delay", () => {
  const [c] = cards(render(newMod(root())));
  assert.equal(c.props.trigger.props.tooltip, "#16 · CI failing");
  assert.ok(String(c.props.trigger.props.id).startsWith("pr-"));
  assert.equal(c.props.open_delay, 300);
});

test("the anchor starts below the chip and follows its position: near the bottom the card goes above", () => {
  const mod = newMod(root());
  const first = cards(render(mod))[0];
  assert.equal(first.props.anchor, "top_center");
  let notified = 0;
  const cx = { notify: () => { notified++; } };
  globalThis.window = { viewport_size: () => ({ width: 300, height: 800 }) };
  try {
    first.props.trigger.props.on_mouse_move(move(780), cx);
    assert.equal(notified, 1);
    assert.equal(cards(render(mod))[0].props.anchor, "bottom_center");
    first.props.trigger.props.on_mouse_move(move(780), cx);
    assert.equal(notified, 1, "no redraw while the anchor is unchanged");
  } finally { delete globalThis.window; }
});

test("the size comes from the global window (a handler's cx has none): near the bottom the anchor flips to bottom_center", () => {
  const mod = newMod(root());
  const first = cards(render(mod))[0];
  globalThis.window = { viewport_size: () => ({ width: 300, height: 800 }) };
  try {
    let notified = 0;
    first.props.trigger.props.on_mouse_move(move(780), { notify: () => { notified++; } });
    assert.equal(notified, 1);
    assert.equal(cards(render(mod))[0].props.anchor, "bottom_center");
    first.props.trigger.props.on_mouse_move(move(60), { notify: () => {} });
    assert.equal(cards(render(mod))[0].props.anchor, "top_center");
  } finally { delete globalThis.window; }
});

test("a chip click in an Agents row does not focus the pane (stop_propagation); a click on the row does", () => {
  const withUrl = treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", dots: [{ ...dot(16, "fail"), url: "https://github.com/o/r/pull/16" }] }, []));
  const mod = newMod(withUrl);
  mod.openUrl = () => {};
  const tree = render(mod);
  stubs.world.runCalls = [];
  const [c] = cards(tree);
  let stopped = 0;
  c.props.trigger.props.on_click({}, { stop_propagation: () => { stopped++; }, notify() {} });
  assert.equal(stopped, 1);
  assert.equal(stubs.world.runCalls.filter((r) => r[0] === "pane.focus").length, 0);
  const row = walk(tree).find((e) => e.props?.id === "agent:t5");
  assert.ok(row, "the agent row");
  row.props.on_click({}, { notify() {} });
  assert.equal(stubs.world.runCalls.filter((r) => r[0] === "pane.focus").length, 1);
});

test("a chip high in the window keeps the card below", () => {
  const mod = newMod(root());
  const first = cards(render(mod))[0];
  globalThis.window = { viewport_size: () => ({ width: 300, height: 800 }) };
  try {
    first.props.trigger.props.on_mouse_move(move(60), { notify: () => {} });
    assert.equal(cards(render(mod))[0].props.anchor, "top_center");
  } finally { delete globalThis.window; }
});
