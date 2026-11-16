import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const node = (key, name, hc, show, children = [], parent = "") => ({ key, kind: "session", name, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children });
const RADAR = () => ({ machines: { local: [node("fm", "foreman", "t1", { dir: "/s/fm", plan: 3, note: 1 }, [node("c1", "guard-prefix", "tc1", { dir: "/s/c1" }, [], "fm")]), node("other", "other-foreman", "t2", { dir: "/s/other" })] } });
const at = (min) => new Date(Date.now() - min * 60000).toISOString();
const entry = (id, o = {}) => ({ id, kind: id === "plan" ? "plan" : id === "result" ? "result" : "note", title: id, state: "shown", version: 1, at: at(1), file: `${id}.html`, ...o });
const index = (pages, events = []) => JSON.stringify({ v: 1, pages, events });

function reset() {
  world.files = new Map([
    ["/s/fm/pages/pages.json", index([entry("plan", { title: "Plan x", state: "waits for you", version: 3, at: at(5) }), entry("note-1", { title: "Why", at: at(2) })],
      [{ at: at(4), kind: "plan_review", text: "Plan review: PASS" }, { at: at(3), kind: "pr", text: "PR opened: https://example.org/o/r/pull/7" }])],
    ["/s/c1/pages/pages.json", index([entry("result", { title: "Child result", state: "written" })])],
  ]);
  world.reads = [];
  world.shared = { "pi-foreman.radar": RADAR() };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }, { address: "t2", tab: "tabB", pane: "p2" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }, { pane: "p2", tab: "tabB", terminal: "t2" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
  world.execCalls = [];
}

function boot() {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  // the stubs answer at once, so a few turns of the event loop let every spawned task finish (a watch loop never does)
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return { m, cx, settle };
}

const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const strings = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);

test("empty states: no radar, no focus, no agent in the tab, no pages published", async () => {
  reset();
  world.shared = {};
  let b = boot(); await b.settle();
  assert.ok(strings(b.m.render(b.cx)).includes("Waiting for foreman radar"));
  reset(); world.focus = null;
  b = boot(); await b.settle();
  assert.ok(strings(b.m.render(b.cx)).includes("No herdr-app session focused"));
  reset(); world.focus = { ...world.focus, tab: "tabZ", pane: null };
  b = boot(); await b.settle();
  assert.ok(strings(b.m.render(b.cx)).includes("No agent session in this tab"));
  reset(); world.files.delete("/s/fm/pages/pages.json");
  b = boot(); await b.settle();
  assert.ok(strings(b.m.render(b.cx)).includes("No pages published by this session"));
});

test("the foreman's pages come newest first with a state chip and an age; milestones follow, newest first", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const tree = m.render(cx);
  const s = strings(tree);
  assert.ok(s.includes("plan v3 · waits for you") && s.includes("note v1 · shown"), "state chips");
  assert.ok(s.includes("5m") && s.includes("2m"), "ages");
  assert.ok(s.indexOf("Why") < s.indexOf("Plan x"), "the newer note is listed above the older plan");
  assert.ok(s.includes("Milestones"));
  assert.ok(s.indexOf("PR opened: https://example.org/o/r/pull/7") < s.indexOf("Plan review: PASS"), "milestones newest first");
  assert.ok(byId(tree, "page-plan") && byId(tree, "page-note-1"));
});

test("tabs: the foreman, then each child session by its radar parent; the child's tab lists the child's pages", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  assert.deepEqual(m.cur.tabs.map((t) => t.label), ["Foreman", "guard-prefix"]);
  assert.ok(byId(m.render(cx), "tab-c:c1"));
  m.tab = "c:c1"; m.sync(); m.reload(cx); await settle();
  const s = strings(m.render(cx));
  assert.ok(s.includes("Child result") && s.includes("result · written"));
  assert.ok(!s.includes("Plan x"), "the foreman's pages are not listed on the child's tab");
});

test("keyboard focus on another terminal never moves the panel off the tab's foreman", async () => {
  reset();
  const { m, settle } = boot(); await settle();
  assert.equal(m.cur.root.key, "fm");
  // focus moves to the foreman of another tab's terminal as a floating window would: no pane in this tab
  world.focus = { space: "s", tab: "tabA", pane: null, terminal: "t2", shown: null, agent: "t2", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "fm");
  assert.equal(m.tab, "foreman", "an unrelated terminal selects nothing");
  // a floating child of this foreman: its tab is selected, the root stays
  world.focus = { space: "s", tab: "tabA", pane: null, terminal: "tc1", shown: null, agent: "tc1", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "fm");
  assert.equal(m.tab, "c:c1");
  // the user picks the Foreman tab; the same floating focus does not pull it back
  m.tab = "foreman"; m.sync();
  assert.equal(m.tab, "foreman");
  // back in the pane: the same
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "fm");
});

test("switching to another tab switches the foreman; the tab selection starts over", async () => {
  reset();
  const { m, settle } = boot(); await settle();
  m.tab = "c:c1"; m.sync();
  world.focus = { space: "s", tab: "tabB", pane: "p2", terminal: "t2", shown: null, agent: "t2", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "other");
  assert.equal(m.tab, "foreman");
});

test("a sidebar pin selects the session's tab and holds until the tab's foreman changes", async () => {
  reset();
  const { m, settle } = boot(); await settle();
  world.shared["pi-foreman.show"] = { key: "c1", kind: "plan", n: 1 };
  m.sync();
  assert.equal(m.tab, "c:c1");
  m.tab = "foreman"; m.sync();
  assert.equal(m.tab, "foreman", "the pin selected once; the user may move on");
  world.shared["pi-foreman.show"] = { key: "fm", kind: "note", n: 2 };
  m.tab = "c:c1"; m.sync();
  assert.equal(m.tab, "foreman");
  // a pin on a session outside this tab's tree shows that session
  world.shared["pi-foreman.show"] = { key: "other", kind: "plan", n: 3 };
  m.sync();
  assert.equal(m.cur.root.key, "other");
  world.focus = { space: "s", tab: "tabB", pane: "p2", terminal: "t2", shown: null, agent: "t2", cwd: null };
  m.sync();
  assert.equal(m.pin, null, "the pin ended with the change of foreman");
});

test("a re-read with the same bytes re-renders nothing; a changed pages.json does", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const before = cx.notified;
  m.reload(cx); await settle();
  assert.equal(cx.notified, before);
  world.files.set("/s/fm/pages/pages.json", index([entry("plan", { title: "Plan y", version: 4 })]));
  m.reload(cx); await settle();
  assert.ok(cx.notified > before);
  assert.ok(strings(m.render(cx)).includes("plan v4 · shown"));
});

test("links: only https opens, through the platform opener; a milestone without a link is not clickable", async () => {
  reset();
  world.files.set("/s/fm/pages/pages.json", index([entry("plan")], [
    { at: at(1), kind: "x", text: "see javascript:alert(1)" },
    { at: at(1), kind: "x", text: "see http://example.org/" },
    { at: at(1), kind: "x", text: "plain text" },
    { at: at(1), kind: "x", text: "PR opened: https://example.org/a" },
  ]));
  const { m, cx, settle } = boot(); await settle();
  const tree = m.render(cx);
  // newest first: events 0..3 are the file order reversed
  assert.equal(byId(tree, "event-1").props.on_click, undefined, "plain text");
  assert.equal(byId(tree, "event-2").props.on_click, undefined, "http");
  assert.equal(byId(tree, "event-3").props.on_click, undefined, "javascript");
  const handler = byId(tree, "event-0").props.on_click;
  assert.equal(typeof handler, "function");
  assert.deepEqual(world.execCalls, []);
  handler(null, cx);
  await settle();
  assert.equal(world.execCalls.length, 1);
  assert.deepEqual(world.execCalls[0], ["xdg-open", ["https://example.org/a"], { timeout: 10000 }], "the window stub has no platform: the Linux opener");
});
