import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const els = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => els(k, out));
  if (el.contentEl) els(el.contentEl, out);
  if (el.props?.trigger) els(el.props.trigger, out);
  return out;
};
const card = (root) => els(root).find((e) => e.kind === "HoverCard" && e.cardId === "legend-card");

test("the legend content stays while the pointer is on the open card, and goes 1 s after it left both", () => {
  world.props = { sample: true };
  const mod = Object.create(Mod.prototype);
  mod.init({}, { timer: { every() {} }, spawn() {}, notify() {} });
  const real = Date.now;
  let now = 9_000_000;
  Date.now = () => now;
  try {
    const cx = { n: 0, notify() { cx.n++; } };
    card(mod.render({})).props.trigger.props.on_hover(true, cx);
    let root = mod.render({});
    const over = (c, hovered) => c.contentEl.props.on_hover(hovered, cx);
    assert.equal(typeof card(root).contentEl.props.on_hover, "function", "the card content reports hover");
    // the pointer moves from the ? onto the card (leave and enter in either order)
    card(root).props.trigger.props.on_hover(false, cx);
    over(card(root), true);
    now += 5000; mod.tickClocks(cx);
    assert.equal(mod.legendHot, true, "pointer on the card: content kept");
    over(card(root), false);
    now += 500; mod.tickClocks(cx);
    assert.equal(mod.legendHot, true);
    now += 600; mod.tickClocks(cx);
    assert.equal(mod.legendHot, false, "left both: dropped after 1 s");
    // enter the card first, then the ? reports its leave
    card(root).props.trigger.props.on_hover(true, cx);
    root = mod.render({});
    over(card(root), true);
    card(root).props.trigger.props.on_hover(false, cx);
    now += 5000; mod.tickClocks(cx);
    assert.equal(mod.legendHot, true, "enter before leave: still kept");
  } finally { Date.now = real; }
});
