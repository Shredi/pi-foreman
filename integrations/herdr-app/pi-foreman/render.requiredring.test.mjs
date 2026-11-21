import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

// The required-check ring: an amber border with no fill, still, drawn by the one dot renderer; sample PR 116 is the case.
const cx = { timer: { every() {} }, spawn() {}, notify() {} };

function sampleRoot() {
  world.props = { sample: true };
  world.execCalls = [];
  world.agentOrder = [];
  const mod = Object.create(Mod.prototype);
  mod.init({}, cx);
  return mod.render({});
}

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const hasText = (el, text) => (el.kids ?? []).includes(text);

// The chip of PR `n`: the HoverCard whose trigger draws "PR #n", and its badge.
const chipOf = (root, n) => walk(root).filter((e) => e.kind === "HoverCard").find((c) => walk(c.props.trigger).some((e) => hasText(e, `PR #${n}`) || hasText(e, `#${n}`)));
const discOf = (chip) => walk(chip.props.trigger).find((e) => e.props?.font_semibold && e.props.text_size === 10);

test("sample PR 116 (checks passed, required checks waiting): a still amber outlined badge, no fill, no loop", () => {
  const root = sampleRoot();
  const chip = chipOf(root, 116);
  assert.ok(chip, "#116 is drawn");
  const disc = discOf(chip);
  assert.equal(disc.props.border_color, "#ansi3", "amber border");
  assert.equal(disc.props.border, 1);
  assert.equal(disc.props.bg, undefined, "no background fill");
  assert.equal(disc.props.loop, undefined, "never pulses");
});

test("the ring is not a pulsing disc: the sample keeps its three pulsing PR discs", () => {
  const root = sampleRoot();
  assert.equal(walk(root).filter((e) => e.props?.loop !== undefined).length, 3);
});

test("merge-blocked PR 110 without waiting names keeps its filled amber badge", () => {
  const root = sampleRoot();
  const disc = discOf(chipOf(root, 110));
  assert.equal(disc.props.bg, "#ansi32e");
  assert.equal(disc.props.border_color, "#ansi355");
});
