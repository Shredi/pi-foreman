import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const FLOOR = 600000;
const BROKEN = () => ({ number: 5, get repo() { throw new Error("broken entry"); } });
const GOOD = { number: 5, repo: "o/r", url: "", title: "Fix the thing", state: "open", checks: [], jobs: [] };

function mod(openPrs) {
  world.agents = [];
  world.terminals = [];
  world.notices = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set();
  m.radar = new Map([["local", { ok: true, tree: [], openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.foremanProp = undefined; m.hcProp = undefined;
  return m;
}
const cx = { spawn() {}, notify() {}, sleep: () => new Promise(() => {}) };
const notices = () => world.notices.filter((n) => /did not finish drawing/.test(n.title));

// Date.now is pinned for the 10-minute floor and put back after each test.
function clock(test_) {
  const real = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const advance = (ms) => { now += ms; };
  try { return test_(advance); } finally { Date.now = real; }
}

test("a render whose PR part fell back still draws; the next tick posts one warning, a second fault within 10 minutes none, one after the floor", () => {
  clock((advance) => {
    const m = mod([BROKEN()]);
    assert.ok(m.render({}), "the view is drawn");
    assert.equal(notices().length, 0, "nothing is posted from inside render");
    m.poll(cx);
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].level, "warning");
    m.poll(cx);
    assert.equal(notices().length, 1, "the flags were cleared by the tick");
    advance(1000);
    m.render({});
    m.poll(cx);
    assert.equal(notices().length, 1, "within the floor");
    advance(FLOOR);
    m.render({});
    m.poll(cx);
    assert.equal(notices().length, 2, "after the floor");
  });
});

test("a render left open (cut short) gives a notice on the next tick", () => {
  clock(() => {
    const m = mod([GOOD]);
    m.render({});
    m.renderOpen = true;
    m.poll(cx);
    assert.equal(notices().length, 1);
    m.poll(cx);
    assert.equal(notices().length, 1, "counted once");
  });
});

test("a cut-short render gives one notice; a tick past the floor with no render in between gives none (the tick resets renderOpen)", () => {
  clock((advance) => {
    const m = mod([GOOD]);
    m.render({});
    m.renderOpen = true;
    m.poll(cx);
    assert.equal(notices().length, 1);
    advance(FLOOR + 1000);
    m.poll(cx);
    assert.equal(notices().length, 1);
  });
});

test("a cut-short render followed by a clean one still gives one notice (sticky renderBroke)", () => {
  clock(() => {
    const m = mod([GOOD]);
    m.renderOpen = true;
    m.render({});
    m.render({});
    m.poll(cx);
    assert.equal(notices().length, 1);
  });
});

test("a faulty render followed by a clean one still gives one notice (sticky prFault)", () => {
  clock(() => {
    const m = mod([BROKEN()]);
    m.render({});
    m.radar.get("local").openPrs = [GOOD];
    m.render({});
    m.poll(cx);
    assert.equal(notices().length, 1);
  });
});

test("after the tick read the flags, a clean render and a tick past the floor give no notice", () => {
  clock((advance) => {
    const m = mod([BROKEN()]);
    m.render({});
    m.poll(cx);
    assert.equal(notices().length, 1);
    m.radar.get("local").openPrs = [GOOD];
    m.render({});
    advance(FLOOR + 1000);
    m.poll(cx);
    assert.equal(notices().length, 1);
  });
});

test("a clean render gives no notice", () => {
  clock(() => {
    const m = mod([GOOD]);
    m.render({});
    m.render({});
    m.poll(cx);
    assert.equal(notices().length, 0);
  });
});

test("sample mode posts no notice", () => {
  clock(() => {
    const m = mod([GOOD]);
    m.sample = true;
    m.renderOpen = true;
    m.prFault = true;
    m.poll(cx);
    assert.equal(notices().length, 0);
  });
});
