import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const PLAN = "/w/.workflow/scratch/plan-x.md";
const HANDOFF = "/h/c1/plan.md";
const node = (key, name, hc, show, children = [], parent = "") => ({ key, kind: "session", name, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children });
const RADAR = () => ({ machines: { local: [node("fm", "foreman", "t1", { dir: "/s/fm", plan: 3, note: 1 }, [node("c1", "guard-prefix", "tc1", { dir: "/s/c1", plan: 1 }, [], "fm")]), node("other", "other-foreman", "t2", { dir: "/s/other", plan: 1 })] } });
const meta = (o = {}) => JSON.stringify({ path: PLAN, title: "Plan x", v: 3, at: "2026-11-06T10:00:00Z", hash: "h2", ruledPath: PLAN, ruledHash: "h1", prevHash: "h0", fences: [], ...o });

function reset() {
  world.files = new Map([
    ["/s/fm/plan.json", meta()], [PLAN, "# Plan\n\n## Goal\nShow it.\n\nA new paragraph.\n"], ["/s/fm/plan.ruled.md", "# Plan\n\n## Goal\nShow it.\n"],
    ["/s/c1/plan.json", meta({ path: HANDOFF, ruledPath: null, title: "Child", v: 1 })], [HANDOFF, "# Child plan\n\nwork\n"],
    ["/s/fm/note.json", JSON.stringify({ title: "Why", v: 1, at: "2026-11-06T10:00:00Z", hash: "n", fences: [] })], ["/s/fm/note.md", "# Note\n\nbody\n"],
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
const views = (el) => walk(el).filter((e) => e.kind === "TextView");
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);

test("empty states: no radar, no focus, no agent in the tab, no plan published", async () => {
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
  reset(); world.files.delete("/s/fm/plan.json");
  b = boot(); await b.settle();
  assert.ok(strings(b.m.render(b.cx)).includes("No plan published by this session"));
});

test("the foreman's plan renders with a NEW block against the ruled snapshot, badge and version", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const tree = m.render(cx);
  const s = strings(tree);
  assert.ok(s.includes("1 addition") && s.includes("NEW") && s.includes("v3") && s.includes("Rendered") && s.includes("Diff"));
  assert.ok(s.includes("Plan") && !s.includes("CHANGED"));
  const md = views(tree).map((v) => v.md);
  assert.ok(md.includes("A new paragraph.") && md.includes("## Goal"));
  assert.ok(strings(tree).includes("x"), "topic badge from plan-<topic>.md");
});

test("tabs: Plan, Note, then the child's plan by its radar parent; the child's tab shows the child's plan", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const tabs = m.cur.tabs.map((t) => t.label);
  assert.deepEqual(tabs, ["Plan", "Note", "guard-prefix"]);
  assert.ok(byId(m.render(cx), "tab-c:c1"));
  m.tab = "c:c1"; m.sync(); m.reload(cx); await settle();
  const md = views(m.render(cx)).map((v) => v.md);
  assert.ok(md.includes("# Child plan"));
  assert.ok(!strings(m.render(cx)).includes("NEW"), "no snapshot of the child's plan path: no marks, no badge");
});

test("keyboard focus on another terminal never moves the panel off the tab's foreman", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  assert.equal(m.cur.root.key, "fm");
  // focus moves to the foreman of another tab's terminal as a floating window would: no pane in this tab
  world.focus = { space: "s", tab: "tabA", pane: null, terminal: "t2", shown: null, agent: "t2", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "fm");
  assert.equal(m.tab, "plan", "an unrelated terminal selects nothing");
  // a floating child of this foreman: its tab is selected, the root stays
  world.focus = { space: "s", tab: "tabA", pane: null, terminal: "tc1", shown: null, agent: "tc1", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "fm");
  assert.equal(m.tab, "c:c1");
  // the user picks the Plan tab; the same floating focus does not pull it back
  m.tab = "plan"; m.sync();
  assert.equal(m.tab, "plan");
  // back in the pane: the same
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "fm");
});

test("switching to another tab switches the foreman; the tab selection starts over", async () => {
  reset();
  const { m, settle } = boot(); await settle();
  m.tab = "note";
  world.focus = { space: "s", tab: "tabB", pane: "p2", terminal: "t2", shown: null, agent: "t2", cwd: null };
  m.sync();
  assert.equal(m.cur.root.key, "other");
  assert.equal(m.tab, "plan");
});

test("a sidebar pin selects the document and holds until the tab's foreman changes", async () => {
  reset();
  const { m, settle } = boot(); await settle();
  world.shared["pi-foreman.show"] = { key: "c1", kind: "plan", n: 1 };
  m.sync();
  assert.equal(m.tab, "c:c1");
  m.tab = "plan"; m.sync();
  assert.equal(m.tab, "plan", "the pin selected once; the user may move on");
  world.shared["pi-foreman.show"] = { key: "fm", kind: "note", n: 2 };
  m.sync();
  assert.equal(m.tab, "note");
  // a pin on a session outside this tab's tree shows that session
  world.shared["pi-foreman.show"] = { key: "other", kind: "plan", n: 3 };
  m.sync();
  assert.equal(m.cur.root.key, "other");
  world.focus = { space: "s", tab: "tabB", pane: "p2", terminal: "t2", shown: null, agent: "t2", cwd: null };
  m.sync();
  assert.equal(m.pin, null, "the pin ended with the change of foreman");
});

test("a re-read with the same bytes re-renders nothing and re-reads no document; a changed plan.json does", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  const docReads = () => world.reads.filter(([p]) => p === PLAN).length;
  const before = [docReads(), cx.notified];
  m.reload(cx); await settle();
  assert.deepEqual([docReads(), cx.notified], before);
  world.files.set("/s/fm/plan.json", meta({ hash: "h3" }));
  world.files.set(PLAN, "# Plan\n\n## Goal\nShow it.\n\nA new paragraph.\n\nAnother.\n");
  m.reload(cx); await settle();
  assert.equal(docReads(), before[0] + 1);
  assert.equal(cx.notified, before[1] + 1);
  // the plan folder's watch asks for the documents even when the JSON bytes are the same
  world.files.set(PLAN, "# Plan\n\n## Goal\nShow it.\n\nA new paragraph.\n\nThird.\n");
  m.reload(cx); await settle();
  assert.equal(docReads(), before[0] + 1, "same JSON bytes: documents are not re-read");
  m.dirty = true; m.reload(cx); await settle();
  assert.equal(docReads(), before[0] + 2);
});

test("a roll that changes only ruledHash is picked up: the marks move to the new comparison", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  assert.equal(m.recs.get("local|/s/fm").plan.adds, 1);
  world.files.set("/s/fm/plan.json", meta({ hash: "h2", ruledHash: "h2", prevHash: "h1" }));
  world.files.set("/s/fm/plan.prev.md", "# Plan\n\n## Goal\nShow it.\n\nA new paragraph.\n");
  m.reload(cx); await settle();
  assert.equal(m.recs.get("local|/s/fm").plan.adds, 0, "compared with prev, which equals the current document");
  assert.ok(!strings(m.render(cx)).some((x) => /addition/.test(x)));
});

test("a missing comparison snapshot means no marks and no badge", async () => {
  reset();
  world.files.delete("/s/fm/plan.ruled.md");
  const { m, cx, settle } = boot(); await settle();
  assert.equal(m.recs.get("local|/s/fm").plan.adds, 0);
  assert.ok(!strings(m.render(cx)).some((x) => /addition|NEW|CHANGED/.test(x)));
});

test("the Diff view lists the changed lines under their heading", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.diff = true;
  const s = strings(m.render(cx));
  assert.ok(s.includes("@@ Goal @@") && s.includes("A new paragraph.") && s.includes("+"));
});

test("a plan path that is not a readable .md is not read", async () => {
  reset();
  world.files.set("/s/fm/plan.json", meta({ path: "/etc/passwd", ruledPath: "/etc/passwd" }));
  world.files.set("/etc/passwd", "root:x");
  const { m, cx, settle } = boot(); await settle();
  assert.ok(!world.reads.some(([p]) => p === "/etc/passwd"));
  assert.ok(strings(m.render(cx)).includes("No plan published by this session"));
});

test("links: only https opens, through the platform opener; markup in the plan is sanitised before it renders", async () => {
  reset();
  world.files.set(PLAN, "# Plan\n\n![x](https://t/x.png) <img src=x> [a](https://example.org/a)\n");
  world.files.set("/s/fm/plan.ruled.md", "# Plan\n");
  const { m, cx, settle } = boot(); await settle();
  const v = views(m.render(cx)).find((x) => x.md.includes("example.org"));
  assert.equal(v.md, "!\\[x](https://t/x.png)  [a](https://example.org/a)");
  const handler = v.props.on_link_click;
  assert.equal(typeof handler, "function");
  handler("javascript:alert(1)", cx); handler("http://example.org/", cx); handler("https://example.org/a b", cx);
  await settle();
  assert.deepEqual(world.execCalls, []);
  handler("https://example.org/a", cx);
  await settle();
  assert.equal(world.execCalls.length, 1);
  assert.deepEqual(world.execCalls[0], ["xdg-open", ["https://example.org/a"]], "the window stub has no platform: the Linux opener");
});
