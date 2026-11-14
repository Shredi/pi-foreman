import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { world } = stubs;

// Open PRs of four states, each one chip in the Open PRs section: a draft with checks running, a running PR, a failed one, a passed one.
const H1 = "1111111111111111111111111111111111111111";
const entry = (number, over = {}) => ({ number, repo: "acme/app", title: `PR ${number}`, url: `https://example.test/acme/app/pull/${number}`, state: "open", head: H1, mergeState: "clean", mergeable: "MERGEABLE", headRefName: "feat", checks: [], ...over });
const DOC = {
  v: 1, roots: [], openPrsAt: new Date().toISOString(),
  openPrs: [
    entry(61, { state: "draft", checks: [{ n: "ci", state: "pending" }] }),
    entry(62, { checks: [{ n: "ci", state: "pending" }] }),
    entry(63, { checks: [{ n: "lint", state: "fail" }] }),
    entry(64, { checks: [{ n: "ci", state: "ok" }] }),
  ],
};

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};

function render(doc = DOC) {
  world.agents = [];
  world.terminals = [];
  const d = parseRadarDoc(JSON.stringify(doc));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set();
  m.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), tried: Date.now(), openPrs: d.openPrs, openPrsAt: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  return m.render({});
}

// The chip of PR `n`: the HoverCard whose trigger draws "⎇ #n".
const chipOf = (root, n) => walk(root).filter((e) => e.kind === "HoverCard").find((c) => walk(c.props.trigger).some((e) => (e.kids ?? []).includes(`⎇ #${n}`)));
// The disc of a chip: the 6px element with the fill (its loop, when it pulses, is on the same element).
const dotOf = (chip) => walk(chip.props.trigger).find((e) => e.props.size === 6);

test("the pulse loops the disc in the PR's colour: draft running violet, running amber", () => {
  const root = render();
  const draft = dotOf(chipOf(root, 61));
  assert.deepEqual(draft.props.loop, ["opacity", { from: 0.35, to: 1, period: 1200 }]);
  assert.equal(draft.props.bg, "#ansi5", "violet");
  const running = dotOf(chipOf(root, 62));
  assert.ok(running.props.loop, "running pulses");
  assert.equal(running.props.bg, "#ansi3", "amber");
});

test("failed and passed PRs stay still; the colours are red and green", () => {
  const root = render();
  for (const [n, colour] of [[63, "#blocked"], [64, "#ansi2"]]) {
    const dot = dotOf(chipOf(root, n));
    assert.equal(dot.props.loop, undefined, `#${n} does not pulse`);
    assert.equal(dot.props.bg, colour, `#${n} colour`);
  }
});

test("no PR chip draws a spinner: the turning circle is for agents only", () => {
  const root = render();
  for (const n of [61, 62, 63, 64]) {
    const chip = chipOf(root, n);
    assert.ok(chip, `#${n} is drawn`);
    assert.equal(walk(chip.props.trigger).filter((e) => e.props.spin !== undefined || e.kind === "svg").length, 0, `#${n}`);
  }
});

test("a render where no PR runs loops nothing", () => {
  const still = { ...DOC, openPrs: [entry(64, { checks: [{ n: "ci", state: "ok" }] }), entry(63, { checks: [{ n: "lint", state: "fail" }] })] };
  assert.equal(walk(render(still)).filter((e) => e.props?.loop !== undefined).length, 0);
});
