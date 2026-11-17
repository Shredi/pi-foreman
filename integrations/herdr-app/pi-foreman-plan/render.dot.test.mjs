import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const sess = (key, hc, dir, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", show: { dir }, children: [] });
const entry = (id, o = {}) => ({ id, kind: id === "plan" ? "plan" : "note", title: id, state: "shown", version: 1, at: "2026-11-06T10:00:00Z", file: `${id}.html`, ...o });
const put = (dir, pages) => world.files.set(`${dir}/pages/pages.json`, JSON.stringify({ v: 1, pages, events: [] }));

function reset() {
  world.files = new Map([["/s/b/pages/plan.html", "<p>plan</p>"], ["/s/b/pages/note-1.html", "<p>note</p>"]]);
  put("/s/fm", [entry("plan")]);
  put("/s/b", [entry("plan"), entry("note-1", { at: "2026-11-06T11:00:00Z" })]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null; world.execCalls = [];
  world.platform = "macos"; world.execFn = () => ({ code: 0, stdout: "", stderr: "" }); // a page counts as seen once its opener worked
  world.shared = { "pi-foreman.radar": { machines: { local: [sess("fm", "t1", "/s/fm"), sess("both", "tc2", "/s/b", "fm")] } } };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}
const boot = () => {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { m, cx, settle };
};
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const strings = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);
const label = (el, id) => strings(byId(el, id) ?? { kids: [] }).join("");
const dotted = (el, id) => label(el, id).includes("●");

test("a child's tab: dot while another tab is on screen, off while shown; each entry carries its own dot until opened", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tick(cx); await settle();
  let tree = m.render(cx);
  assert.ok(dotted(tree, "tab-c:both"), "unseen while another tab is on screen");
  m.tab = "c:both"; m.render(cx); await settle();
  tree = m.render(cx);
  assert.ok(!dotted(tree, "tab-c:both"), "no dot on the tab while it is on screen");
  assert.ok(dotted(tree, "page-plan") && dotted(tree, "page-note-1"), "both entries are unseen");
  byId(tree, "page-note-1").props.on_click(null, cx); await settle();
  tree = m.render(cx);
  assert.ok(!dotted(tree, "page-note-1"), "an opened entry's dot clears");
  assert.ok(dotted(tree, "page-plan"), "the other entry keeps its dot");
  // the plan is still unseen: leaving the tab brings the tab dot back
  m.tab = "foreman"; m.render(cx); await settle();
  assert.ok(dotted(m.render(cx), "tab-c:both"));
  m.tab = "c:both"; m.render(cx); await settle();
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  m.tab = "foreman"; m.render(cx); await settle();
  assert.ok(!dotted(m.render(cx), "tab-c:both"), "every entry seen: no dot after leaving");
});

test("a newer version of an opened page sets its dot again", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.tab = "c:both"; m.render(cx); await settle();
  byId(m.render(cx), "page-plan").props.on_click(null, cx); await settle();
  byId(m.render(cx), "page-note-1").props.on_click(null, cx); await settle();
  assert.ok(!dotted(m.render(cx), "page-plan"));
  put("/s/b", [entry("plan", { version: 2 }), entry("note-1", { at: "2026-11-06T11:00:00Z" })]);
  m.reload(cx); await settle();
  assert.ok(dotted(m.render(cx), "page-plan"));
  assert.ok(!dotted(m.render(cx), "page-note-1"));
});
