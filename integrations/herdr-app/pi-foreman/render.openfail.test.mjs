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
const LSO = "_LSOpenURLsWithCompletionHandler() failed with error -600 for the URL https://example.org/o/r/pull/7.";
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const cards = (el) => walk(el).filter((e) => e.kind === "HoverCard");

// A radar document as the tracker writes it: one session and one open PR of the feed that no session works on.
const feedPr = { repo: "o/r", number: 7, title: "Fix the thing", url: URL_, state: "open", checks: [], headRefName: "fix-thing" };
const rendered = () => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess("f", "foreman-x", { hcTerminal: "t5" })], openPrs: [feedPr], openPrsAt: new Date().toISOString() }));
  world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.radar = new Map([["local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() }]]);
  m.poll = () => {};
  const chip = cards(m.render({})).find((c) => walk(c.props.trigger).some((e) => (e.kids ?? []).includes("⎇ #7")));
  return chip;
};
const click = async (execFn) => {
  world.execCalls = []; world.notices = []; world.platform = "macos"; world.execFn = execFn;
  const chip = rendered();
  assert.ok(chip, "the chip of the feed PR");
  const tasks = [];
  const cx = { spawn: (f) => tasks.push(f), notify() {}, stop_propagation() {} };
  chip.props.trigger.props.on_click({}, cx);
  for (const t of tasks) await t(cx);
  await settle();
  world.platform = undefined; world.execFn = undefined;
};

test("a chip click whose opener exits non-zero raises one error notice with the exit code and the first stderr line", async () => {
  await click(() => ({ code: 1, stdout: "", stderr: `${LSO}\nsecond line` }));
  assert.deepEqual(world.execCalls.map((c) => [c[0], c[1]]), [["open", [URL_]]]);
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /exit 1/);
  assert.ok(world.notices[0].body.includes(LSO));
  assert.ok(!world.notices[0].body.includes("second line"));
});

test("a chip click whose opener cannot run raises one error notice with its text", async () => {
  await click(() => { throw new Error("cannot run open: program not found"); });
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /cannot run open: program not found/);
});

test("a chip click that opens the page raises no notice and runs `open` with its timeout", async () => {
  await click(() => ({ code: 0, stdout: "", stderr: "" }));
  assert.deepEqual(world.notices, []);
  assert.deepEqual(world.execCalls, [["open", [URL_], { timeout: 10000 }]]);
});

test("openUrl itself: failure notices and silence, outside the chip", async () => {
  const run = async (execFn) => {
    world.execCalls = []; world.notices = []; world.platform = "macos"; world.execFn = execFn;
    const m = Object.create(Mod.prototype);
    const cx = { spawn: (f) => f(cx) };
    m.openUrl(URL_, cx);
    await settle();
    world.platform = undefined; world.execFn = undefined;
  };
  await run(() => ({ code: 1, stderr: "boom" }));
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].body, "exit 1: boom");
  await run(() => ({ code: 0 }));
  assert.deepEqual(world.notices, []);
});
