import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const T0 = 1_800_000_000_000;
const MIN = 60000;
let now = T0;
const realNow = Date.now;
Date.now = () => now;
test.after(() => { Date.now = realNow; });

const radar = (show, openPrs = [], openPrsAt = null) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess("fm", "foreman", { hcTerminal: "t1", show })] }));
  return { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs, openPrsAt, tried: now };
};
const prs = () => parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs: [{
  repo: "example-org/repo", number: 7, title: "Change", state: "open", headRefName: "feat/7", mergeable: "MERGEABLE",
  url: "https://example.test/example-org/repo/pull/7", checks: [{ n: "build", state: "ok" }],
}] })).openPrs;
const mod = (rec) => {
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", rec]]);
  m.poll = () => {};
  m.machineOf = new Map([[rec.tree[0], "local"]]);
  return m;
};
const cx = () => { const c = { n: 0, notify() { c.n++; }, spawn: (f) => f(c), sleep: () => new Promise(() => {}) }; return c; };
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); el.kids?.forEach((k) => walk(k, out)); if (el.contentEl) walk(el.contentEl, out); } return out; };
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const reset = () => {
  now = T0;
  world.agents = [{ address: "t1", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }];
  world.terminals = [{ address: "t1", state: "live" }];
  world.shared = {};
  world.files = new Map();
  world.reads = [];
};

// Draws `m` at T0, then ticks 30 s later (same label: no notify) and 61 s later (the label moved: notify). Returns the first render's text.
function crossing(m, expectText, prefix) {
  const t = texts(m.render({}));
  assert.ok(t.includes(expectText), `${expectText} in ${t.join("|")}`);
  // only the clock under test counts (the agent row's own age moves at the same time)
  const keys = [...m.clocks.keys()].filter((k) => k.startsWith(prefix));
  assert.equal(keys.length, 1, `one ${prefix} clock`);
  for (const k of [...m.clocks.keys()]) if (!k.startsWith(prefix)) m.clocks.delete(k);
  const c = cx();
  now = T0 + 30_000; m.tickClocks(c);
  assert.equal(c.n, 0, "same label: no notify");
  now = T0 + 61_000; m.tickClocks(c);
  assert.equal(c.n, 1, "label moved: notify");
}

test("a plan row's age notifies the tick only when its label moves", async () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 3 }));
  world.files.set("/s/fm/plan.json", JSON.stringify({ v: 3, at: new Date(T0 - 4 * MIN).toISOString() }));
  const c = cx();
  m.pollShows(c, now);
  await new Promise((r) => setImmediate(r));
  crossing(m, "📄 plan v3 · 4m", "show:");
});

test("an agent row's status age notifies the tick only when its label moves", () => {
  reset();
  const m = mod(radar(undefined));
  m.changed = { t1: { s: "idle", at: T0 - 4 * MIN } };
  crossing(m, "4m", "since:");
});

test("the Open PRs header age notifies the tick only when its label moves", () => {
  reset();
  const m = mod(radar(undefined, prs(), T0 - 4 * MIN));
  crossing(m, "updated 4m ago", "open-prs-age");
});

test("the clocks are those of the last render: a row no longer drawn stops notifying", async () => {
  reset();
  const m = mod(radar({ dir: "/s/fm", plan: 3 }));
  world.files.set("/s/fm/plan.json", JSON.stringify({ v: 3, at: new Date(T0 - 4 * MIN).toISOString() }));
  m.pollShows(cx(), now);
  await new Promise((r) => setImmediate(r));
  assert.ok(texts(m.render({})).includes("📄 plan v3 · 4m"));
  assert.ok([...m.clocks.keys()].some((k) => k.startsWith("show:")));
  m.radar.set("local", radar(undefined));
  m.machineOf = new Map([[m.radar.get("local").tree[0], "local"]]);
  m.render({});
  assert.ok(![...m.clocks.keys()].some((k) => k.startsWith("show:")), "the plan clock is gone");
  for (const k of [...m.clocks.keys()]) if (k.startsWith("since:")) m.clocks.delete(k); // the agent row's own age moves too
  const c = cx();
  now = T0 + 5 * MIN; m.tickClocks(c);
  assert.equal(c.n, 0);
});
