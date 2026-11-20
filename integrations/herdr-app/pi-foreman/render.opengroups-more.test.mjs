import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc } = await import("./model.js");

const FAIL = [{ n: "build", state: "ok" }, { n: "lint", state: "fail" }];
const KINDS = {
  ok: {},
  fail: { checks: FAIL },
  conflict: { mergeable: "CONFLICTING", mergeState: "dirty" },
};

// `spec`: [repo, number, kind]; neutral example names.
function docOf(spec) {
  const openPrs = spec.map(([repo, n, kind = "ok"]) => ({
    repo: `example-org/${repo}`, number: n, title: `Change ${n}`, state: "open", headRefName: `feat/${n}`, mergeable: "MERGEABLE", mergeState: "clean",
    url: `https://example.test/example-org/${repo}/pull/${n}`, checks: [{ n: "build", state: "ok" }], ...KINDS[kind],
  }));
  return parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs, openPrsAt: "2026-11-17T10:00:00Z" }));
}
function mod(doc) {
  stubs.world.agents = [];
  stubs.world.terminals = [];
  stubs.world.notices = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: doc.nodes, openPrs: doc.openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set();
  return m;
}
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");
const nums = (root) => cards(root).map((c) => Number(texts(c.props.trigger).find((s) => /^⎇ #\d+$/.test(s)).slice(3)));
const more = (root, repo) => walk(root).find((e) => e.props?.id === `opm-example-org/${repo}`);
const head = (root, repo) => walk(root).find((e) => e.props?.id === `oph-example-org/${repo}`);
const cx = { notify() {}, spawn() {} };
const many = (n, kind) => Array.from({ length: n }, (_, i) => ["alpha", 100 + i, kind]);

test("a failing group of 12 draws 8 lines and one +4 more line; a click shows all 12 until the group is folded", () => {
  const m = mod(docOf(many(12, "fail")));
  let root = m.render({});
  assert.equal(cards(root).length, 8);
  assert.deepEqual(texts(more(root, "alpha")), ["+4 more"]);
  more(root, "alpha").props.on_click({}, cx);
  root = m.render({});
  assert.equal(cards(root).length, 12, "the whole group");
  assert.equal(more(root, "alpha"), undefined, "no +N more line any more");
  head(root, "alpha").props.on_click({}, cx); // fold
  root = m.render({});
  assert.equal(cards(root).length, 0, "a folded group builds no lines");
  head(root, "alpha").props.on_click({}, cx); // open again
  root = m.render({});
  assert.equal(cards(root).length, 8, "folding took the full view away");
  assert.deepEqual(texts(more(root, "alpha")), ["+4 more"]);
});

test("the conflicting PR is in the first 8 even when the sort puts it after the failing ones", () => {
  const spec = [...many(10, "fail"), ["alpha", 50, "conflict"]];
  const root = mod(docOf(spec)).render({});
  assert.equal(cards(root).length, 8);
  assert.ok(nums(root).includes(50), "the conflict is drawn");
  assert.deepEqual(texts(more(root, "alpha")), ["+3 more"]);
});

test("a group with only conflicts is capped too, and a group of up to 8 has no +N more line", () => {
  const conflicts = mod(docOf(many(11, "conflict"))).render({});
  assert.equal(cards(conflicts).length, 8);
  assert.deepEqual(texts(more(conflicts, "alpha")), ["+3 more"]);
  const eight = mod(docOf(many(8, "fail"))).render({});
  assert.equal(cards(eight).length, 8);
  assert.equal(more(eight, "alpha"), undefined);
});

test("a group without attention is not capped: opened by hand it shows all its lines", () => {
  const m = mod(docOf([...many(20, "ok"), ...many(1, "fail").map(([, n, k]) => ["bravo", n + 500, k])]));
  let root = m.render({});
  assert.equal(more(root, "alpha"), undefined);
  head(root, "alpha").props.on_click({}, cx); // opens the auto-folded group
  root = m.render({});
  assert.equal(nums(root).filter((n) => n < 500).length, 20, "all 20 lines");
  assert.equal(more(root, "alpha"), undefined);
});
