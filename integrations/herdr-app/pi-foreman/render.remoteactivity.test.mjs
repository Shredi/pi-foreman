import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { attachName } = await import("./model.js");
const { sess, treeOf } = await import("./fixtures.mjs");

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const byId = (root, prefix) => walk(root).filter((e) => String(e.props.id ?? "").startsWith(prefix));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

// Local session p (agent t5) with one remote registry child `label@box1` (hc terminal box1/t7), working per the registry.
const reg = () => sess("fm-label-a1b2c3", "label@box1", { machine: "box1", hcTerminal: "box1/t7", state: "working", sym: "working", parent: "p" });
const mirrorName = attachName("box1", "fm-label-a1b2c3");
const own = { address: "box1/t7", pane: "p7", space: 2, space_name: "box1 space", status: "done", app: "pi", program: { name: "pi" } };
const scout = { recs: [{ title: "scout", state: "working", msg: "reading" }], attach: "", tried: Date.now() };

function setup({ mirror = false, listedOwn = false, recs = [] } = {}) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }, ...(listedOwn ? [own] : [])];
  stubs.world.terminals = [
    { address: "t5", state: "live", foreground: { pid: 7 } },
    ...(mirror ? [{ address: "t3", state: "live", name: mirrorName, parent: "t5", argv: ["hc", "attach", "box1/t7"] }] : []),
  ];
  stubs.world.spaces = [{ id: 1, machine: null }, { id: 2, machine: "box1" }];
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [reg()]))], openPrs: [], tried: Date.now() }], ["box1", { ok: false, tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(recs); mod.childPi = new Set();
  mod.poll = () => {};
  return mod;
}
const has = (root, text) => texts(root).includes(text);
const recorder = () => { const tasks = []; return { tasks, cx: { spawn: (f) => tasks.push(f), notify() {} } }; };

test("the remote session's row shows the subagents of the records of its remote terminal", () => {
  const root = setup({ recs: [["box1/t7", scout]] }).render({});
  assert.ok(has(root, "scout · reading"));
});

test("the same rows whether or not a mirror terminal or a listed remote terminal exists", () => {
  for (const o of [{ mirror: false }, { mirror: true }, { listedOwn: true }, { mirror: true, listedOwn: true }]) {
    const root = setup({ ...o, recs: [["box1/t7", scout]] }).render({});
    assert.equal(texts(root).filter((x) => x === "scout · reading").length, 1, JSON.stringify(o));
    assert.equal(texts(root).filter((x) => x === "label@box1").length, 1, JSON.stringify(o));
  }
});

test("a record of the mirror terminal or of another address is not the source of the row", () => {
  const root = setup({ mirror: true, recs: [["t3", scout], ["box1/t9", scout]] }).render({});
  assert.ok(!has(root, "scout · reading"));
});

test("records are polled for the drawn remote session without any mirror or listed remote terminal", () => {
  const mod = setup();
  mod.render({});
  const r = recorder();
  mod.pollRecords(r.cx, Date.now());
  assert.ok(mod.busy.has("hc:box1/t7"));
  assert.equal(r.tasks.length, 1);
});

test("a polled answer is kept for the row, and a click that opens a mirror does not change the source", async () => {
  const mod = setup();
  mod.render({});
  stubs.world.execFn = async () => ({ code: 0, stdout: JSON.stringify({ records: { a: { app: "pi-subagents", state: "working", title: "scout", msg: "reading" } } }) });
  const r = recorder();
  mod.pollRecords(r.cx, Date.now());
  await r.tasks[0](r.cx);
  stubs.world.execFn = null;
  assert.ok(mod.recs.has("box1/t7"), "stored although no mirror or listed terminal is there");
  const before = mod.render({});
  assert.ok(has(before, "scout · reading"));
  const name = byId(before, "name:").find((e) => texts(e).includes("label@box1"));
  name.props.on_click({}, { spawn: (fn) => fn() });
  await new Promise((x) => setTimeout(x, 10));
  assert.equal(stubs.world.execCalls.filter(([, argv]) => argv[0] === "run").length, 1, "the click opened the mirror");
  // the new mirror terminal appears: same row, same records, no second row
  stubs.world.terminals.push({ address: "t3", state: "live", name: mirrorName, parent: "t5", argv: ["hc", "attach", "box1/t7"] });
  const after = mod.render({});
  assert.ok(has(after, "scout · reading"));
  assert.equal(texts(after).filter((x) => x.startsWith("label@box1")).length, 1, "the clicked row shows its pending mark, once");
  assert.ok(!has(after, mirrorName));
  assert.ok(mod.recs.has("box1/t7"));
  const again = recorder();
  mod.pollRecords(again.cx, Date.now());
  assert.ok(mod.recs.has("box1/t7"), "not dropped by the next poll round");
});

test("a remote session that is not drawn (done) is not polled", () => {
  const mod = setup();
  mod.radar.get("local").tree = [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, [{ ...reg(), state: "done" }]))];
  mod.render({});
  const r = recorder();
  mod.pollRecords(r.cx, Date.now());
  assert.equal(r.tasks.length, 0);
});
