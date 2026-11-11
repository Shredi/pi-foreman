import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const URL_ = "https://example.org/o/r/pull/7";
const feedPr = { repo: "o/r", number: 7, title: "Fix the thing", url: URL_, state: "open", checks: [], headRefName: "fix-thing", branch: "fix-thing" };
const dot = (over = {}) => ({ n: 7, state: "ok", label: "#7", src: "pr", ...over });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const chipOf = (out) => walk(out).filter((e) => e.kind === "HoverCard").find((c) => walk(c.props.trigger).some((e) => (e.kids ?? []).includes("⎇ #7")));

// Row shapes: where the session with the PR sits. `top`: the listed agent t5 is joined to the node itself; `hcchild`: the node is
// the radar twin of the live hc terminal t9 below t5 (joined by hcTerminal); `bare`: the live terminal t9 has no radar node.
const mount = (shape, kid, feed) => {
  const kidNode = sess("k", "kid", { repo: "o/r", branch: "fix-thing", hcTerminal: "t9", ...kid });
  const roots = shape === "top" ? [kidNode] : [sess("f", "foreman-x", { hcTerminal: "t5" }, shape === "hcchild" ? [kidNode] : [])];
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs: feed, openPrsAt: new Date().toISOString() }));
  const t5 = { address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } };
  world.agents = shape === "top" ? [{ ...t5, address: "t9" }] : [t5];
  world.terminals = shape === "top" ? [{ address: "t9", state: "live", foreground: { pid: 7 } }]
    : [{ address: "t5", state: "live", foreground: { pid: 7 } }, { address: "t9", agent: "pi", name: "kid", parent: "t5", state: "live", status: "working" }];
  world.spaces = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = feed; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.radar = new Map([["local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() }]]);
  return m;
};
const clickChip = async (m) => {
  world.execCalls = []; world.notices = []; world.platform = "macos"; world.execFn = () => ({ code: 0, stdout: "" });
  const chip = chipOf(m.render({}));
  assert.ok(chip, "the row draws the chip");
  assert.equal(typeof chip.props.trigger.props.on_click, "function", "the chip is drawn and its click is bound");
  const tasks = [];
  chip.props.trigger.props.on_click({}, { spawn: (f) => tasks.push(f), notify() {}, stop_propagation() {} });
  for (const t of tasks) await t();
  await settle();
  world.platform = undefined; world.execFn = undefined;
  assert.deepEqual(world.execCalls.map((c) => [c[0], c[1]]), [["open", [URL_]]]);
};

for (const shape of ["top", "hcchild"]) {
  // a closed or finished child without live children leaves the tree (render.prchip-ended.test.mjs covers it with one)
  for (const state of shape === "top" ? ["working", "done", "closed", "finished", "lost", "stale"] : ["working", "done", "lost", "stale"]) {
    test(`${shape} row, state ${state}, live hc terminal: the chip opens the PR page`, async () => {
      await clickChip(mount(shape, { state, sym: state === "done" ? "done" : state, dots: [dot()] }, [feedPr]));
    });
  }
}

test("hc child row of an ending session, the feed already without the merged PR: a drawn chip opens the page", async () => {
  await clickChip(mount("hcchild", { state: "working", sym: "working", dots: [dot({ url: URL_ })] }, []));
});

test("a chip without a link: a click raises one notice naming the PR and runs no opener; a chip with a link shows no notice", async () => {
  const click = async (m) => {
    world.execCalls = []; world.notices = []; world.platform = "macos"; world.execFn = () => ({ code: 0, stdout: "" });
    const chip = chipOf(m.render({}));
    assert.ok(chip, "the row draws the chip");
    const tasks = [];
    chip.props.trigger.props.on_click({}, { spawn: (f) => tasks.push(f), notify() {}, stop_propagation() {} });
    for (const t of tasks) await t();
    await settle();
    world.platform = undefined; world.execFn = undefined;
  };
  await click(mount("hcchild", { state: "working", sym: "working", dots: [dot()] }, []));
  assert.deepEqual(world.execCalls, []);
  assert.equal(world.notices.length, 1);
  assert.match(world.notices[0].body, /#7/);
  await click(mount("hcchild", { state: "working", sym: "working", dots: [dot()] }, [feedPr]));
  assert.equal(world.execCalls.length, 1);
  assert.deepEqual(world.notices, []);
});
