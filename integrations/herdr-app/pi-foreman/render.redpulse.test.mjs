import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { world } = stubs;

// A failed PR with a job still running pulses in red; a failed PR whose jobs are all finished stands still.
const H1 = "1111111111111111111111111111111111111111";
const entry = (number, over = {}) => ({ number, repo: "acme/app", title: `PR ${number}`, url: `https://example.test/acme/app/pull/${number}`, state: "open", head: H1, mergeState: "clean", mergeable: "MERGEABLE", headRefName: "feat", checks: [], ...over });
const DOC = {
  v: 1, roots: [], openPrsAt: new Date().toISOString(),
  openPrs: [
    entry(71, { checks: [{ n: "lint", state: "fail" }, { n: "ci", state: "pending" }] }),
    entry(72, { checks: [{ n: "lint", state: "fail" }, { n: "ci", state: "ok" }] }),
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

// The chip of PR `n`: the HoverCard whose trigger draws "⎇ #n"; its disc: the 6px element with the fill.
const chipOf = (root, n) => walk(root).filter((e) => e.kind === "HoverCard").find((c) => walk(c.props.trigger).some((e) => (e.kids ?? []).includes(`⎇ #${n}`)));
const dotOf = (chip) => walk(chip.props.trigger).find((e) => e.props.size === 6);

test("the red disc of a failed PR with a job running carries the loop", () => {
  const dot = dotOf(chipOf(render(), 71));
  assert.equal(dot.props.bg, "#blocked", "red");
  assert.deepEqual(dot.props.loop, ["opacity", { from: 0.35, to: 1, period: 1200 }]);
});

test("the red disc of a failed PR whose jobs are all finished stands still", () => {
  const dot = dotOf(chipOf(render(), 72));
  assert.equal(dot.props.bg, "#blocked", "red");
  assert.equal(dot.props.loop, undefined, "#72 does not pulse");
});
