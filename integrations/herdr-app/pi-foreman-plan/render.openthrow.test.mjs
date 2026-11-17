import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const entry = (id) => ({ id, kind: "plan", title: id, state: "shown", version: 1, at: "2026-11-06T10:00:00Z", file: `${id}.html` });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const strings = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);
const dotted = (el, id) => strings(byId(el, id) ?? { kids: [] }).join("").includes("●");

function reset() {
  world.files = new Map([["/s/fm/pages/pages.json", JSON.stringify({ v: 1, pages: [entry("plan")], events: [] })]]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.execCalls = [];
  world.platform = "macos"; world.execFn = () => ({ code: 0, stdout: "", stderr: "" });
  const s = { key: "fm", kind: "session", name: "fm", hcTerminal: "t1", pid: null, parent: "", state: "working", show: { dir: "/s/fm" }, children: [] };
  world.shared = { "pi-foreman.radar": { machines: { local: [s] } } };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}
async function boot() {
  const cx = { spawn(f) { f(cx); }, notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  await settle();
  return { m, cx };
}
test.afterEach(() => { world.platform = undefined; world.execFn = undefined; });

test("a page whose rewrite throws gives one notice, opens nothing and keeps its dot", async () => {
  reset();
  world.files.set("/s/fm/pages/plan.html", { length: 3, toString() { throw new Error("boom"); } });
  const { m, cx } = await boot();
  m.tab = "foreman";
  assert.ok(dotted(m.render(cx), "page-plan"));
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /could not be prepared/);
  assert.deepEqual(world.execCalls, []);
  assert.ok(dotted(m.render(cx), "page-plan"), "the dot stays");
});

test("an opener that fails keeps the dot; one that works clears it", async () => {
  reset();
  world.files.set("/s/fm/pages/plan.html", "<p>x</p>");
  const { m, cx } = await boot();
  world.execFn = () => ({ code: 1, stdout: "", stderr: "no" });
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  assert.equal(world.notices.length, 1);
  assert.ok(dotted(m.render(cx), "page-plan"));
  world.execFn = () => ({ code: 0, stdout: "", stderr: "" });
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  assert.ok(!dotted(m.render(cx), "page-plan"));
});

test("an emoji in a relative src is encoded and the page opens", async () => {
  reset();
  world.files.set("/s/fm/pages/plan.html", '<img src="shots/done 🎉.png">');
  const { m, cx } = await boot();
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  assert.equal(world.writes[0][1], '<img src="file:///s/fm/pages/shots/done%20%F0%9F%8E%89.png">');
  assert.equal(world.execCalls.length, 1);
});

test("a lone surrogate in a relative src does not throw", async () => {
  reset();
  world.files.set("/s/fm/pages/plan.html", '<img src="a\ud83dz.png">');
  const { m, cx } = await boot();
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  assert.equal(world.writes[0][1], '<img src="file:///s/fm/pages/a%EF%BF%BDz.png">');
  assert.deepEqual(world.notices, []);
});

const INDEX = "/s/fm/pages/pages.json";
const put = (pages) => world.files.set(INDEX, JSON.stringify({ v: 1, pages, events: [] }));
// a files map whose read of the index rejects (a read error other than "absent") while `broken.on` is set
const flaky = (broken) => { const f = new Map(); const get = f.get.bind(f); f.get = (k) => { if (k === INDEX && broken.on) throw new Error("io"); return get(k); }; return f; };
const SHOW = [["layout.select", { stack: "panel-body", child: "plan" }], ["layout.show", { id: "panel" }]];

test("a first read that fails records nothing: the next good read only records, a later new page opens the panel", async () => {
  reset();
  const broken = { on: true };
  world.files = flaky(broken);
  const { m, cx } = await boot();
  assert.equal(m.recs.get("local|/s/fm").known, null);
  broken.on = false;
  put([entry("plan")]);
  m.reload(cx); await settle();
  assert.equal(world.runCalls.length, 0, "pages that are not new open nothing");
  assert.deepEqual(m.recs.get("local|/s/fm").pages.map((p) => p.id), ["plan"]);
  put([entry("plan"), entry("note-2")]);
  m.reload(cx); await settle();
  assert.deepEqual(world.runCalls, SHOW);
});

test("a missing index at the first read still lets the first page of the session open the panel", async () => {
  reset();
  world.files.delete(INDEX);
  const { m, cx } = await boot();
  assert.equal(world.runCalls.length, 0);
  put([entry("plan")]);
  m.reload(cx); await settle();
  assert.deepEqual(world.runCalls, SHOW);
});
