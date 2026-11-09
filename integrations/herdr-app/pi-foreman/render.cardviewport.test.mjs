import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { sess, treeOf } = await import("./fixtures.mjs");

// A window whose measurements are legal only while a render pass runs (typings.rs: "Legal from render").
let inRender = false;
const strictWindow = () => ({
  viewport_size: () => {
    if (!inRender) throw new TypeError("window.viewport_size() needs a live host call");
    return { width: 300, height: 800 };
  },
});
function render(mod) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  inRender = true;
  try { return mod.render({}); } finally { inRender = false; }
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
const root = () => treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", dots: [{ n: 16, state: "fail", label: "#16", src: "pr", name: "ci" }] }, []));
const move = (y) => ({ position: { x: 200, y }, local_position: { x: 10, y: 9 }, bounds: { x: 0, y: 0, width: 60, height: 18 } });

test("the viewport size read during render places the card when the handler cannot read it", () => {
  globalThis.window = strictWindow();
  try {
    const mod = newMod(root());
    const first = cards(render(mod))[0];
    let notified = 0;
    first.props.trigger.props.on_mouse_move(move(780), { notify: () => { notified++; } });
    assert.equal(notified, 1);
    assert.equal(cards(render(mod))[0].props.anchor, "bottom_center");
    first.props.trigger.props.on_mouse_move(move(60), { notify: () => {} });
    assert.equal(cards(render(mod))[0].props.anchor, "top_center");
  } finally { delete globalThis.window; }
});

test("the card shell is bounded to the room on its side: max_h of that room and overflow_hidden", () => {
  globalThis.window = { viewport_size: () => ({ width: 300, height: 800 }) };
  try {
    const mod = newMod(root());
    const first = cards(render(mod))[0];
    first.props.trigger.props.on_mouse_move(move(780), { notify: () => {} });
    const [card] = cards(render(mod));
    assert.equal(card.props.anchor, "bottom_center");
    // the chip top is at 771 (780 less the 9 px local offset); the room above it is 771 less the 8 px margin
    assert.equal(card.contentEl.props.max_h, 763);
    assert.equal(card.contentEl.props.overflow_hidden, true);
  } finally { delete globalThis.window; }
});
