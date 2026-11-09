import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const PA = "/w/plan-a.md";
const PB = "/w/plan-b.md";
const meta = (path, v = 1) => JSON.stringify({ path, title: "P", v, at: "2026-11-06T10:00:00Z", hash: "h", ruledPath: null, prevHash: null, fences: [] });
const note = (v = 1) => JSON.stringify({ title: "Why", v, at: "2026-11-06T10:00:00Z", hash: "n" + v, fences: [], diagrams: [] });
const sess = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });
const radar = ({ nonly = 1, both = 1 } = {}) => ({ machines: { local: [
  sess("fm", "t1", { dir: "/s/fm", plan: 1, note: 1 }),
  sess("nonly", "tc1", { dir: "/s/n", note: nonly }, "fm"),
  sess("both", "tc2", { dir: "/s/b", plan: 1, note: both }, "fm"),
] } });

// A Map whose read of a path can be held until released, as in render.held.test.mjs.
class Gated extends Map {
  constructor(entries) { super(entries); this.gate = new Map(); }
  hold(path) { this.gate.set(path, []); }
  flush(path) { for (const f of this.gate.get(path) ?? []) f(); this.gate.delete(path); }
  get(path) {
    const v = super.get(path) ?? null;
    const q = this.gate.get(path);
    if (!q) return v;
    return new Promise((r) => q.push(() => r(v)));
  }
}

function reset() {
  world.files = new Gated([
    ["/s/fm/plan.json", meta(PA)], [PA, "# Plan A\n\nAlpha body.\n"], ["/s/fm/note.json", note()], ["/s/fm/note.md", "# Root note\n\nRootNote.\n"],
    ["/s/n/note.json", note()], ["/s/n/note.md", "# Child note\n\nNoteOnlyBody.\n"],
    ["/s/b/plan.json", meta(PB)], [PB, "# Plan B\n\nBothPlan.\n"], ["/s/b/note.json", note()], ["/s/b/note.md", "# Both note\n\nBothNote.\n"],
  ]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null; world.execCalls = [];
  world.shared = { "pi-foreman.radar": radar() };
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
const mds = (el) => walk(el).filter((e) => e.kind === "TextView").map((v) => v.md);
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);
const tabLabel = (el, id) => strings(byId(el, id) ?? { kids: [] }).join("");

test("a child with only a note gets a tab that shows its note", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tab = "c:nonly"; m.render(cx); await settle();
  const tree = m.render(cx);
  assert.ok(byId(tree, "tab-c:nonly"), "the note-only child has a tab");
  assert.ok(mds(tree).some((t) => t.includes("NoteOnlyBody")), "its body is the note");
  assert.ok(strings(tree).includes("Note"), "the header says Note");
  assert.equal(byId(tree, "part-plan"), undefined, "no Plan | Note switch on a note-only child");
});

test("a child with a plan and a note switches between them; Diff is not offered on the note", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tab = "c:both"; m.render(cx); await settle();
  let tree = m.render(cx);
  assert.ok(mds(tree).some((t) => t.includes("BothPlan")), "the plan is the default part");
  assert.ok(byId(tree, "t-d"), "Diff is offered on the plan");
  assert.ok(byId(tree, "part-plan") && byId(tree, "part-note"), "the switch shows");
  byId(tree, "part-note").props.on_click(null, cx);
  tree = m.render(cx);
  assert.ok(mds(tree).some((t) => t.includes("BothNote")), "the note is shown after the switch");
  assert.ok(!mds(tree).some((t) => t.includes("BothPlan")));
  assert.equal(byId(tree, "t-d"), undefined, "no Diff on the note");
  assert.ok(!strings(tree).includes("Loading…"), "the note was already read: no loading");
});

test("the unseen dot is set on a child's label until its version is rendered, and comes back on a newer version", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tick(cx); await settle(); // first sight of the radar versions
  let tree = m.render(cx);
  assert.ok(tabLabel(tree, "tab-c:nonly").endsWith("●"), "first sight of a child's note: unseen");
  assert.ok(tabLabel(tree, "tab-c:both").endsWith("●"));
  m.tab = "c:nonly"; m.render(cx); await settle();
  tree = m.render(cx);
  assert.ok(!tabLabel(tree, "tab-c:nonly").endsWith("●"), "rendered: the dot clears");
  assert.ok(tabLabel(tree, "tab-c:both").endsWith("●"), "the other child keeps its dot");
  world.shared = { "pi-foreman.radar": radar({ nonly: 2 }) };
  m.tick(cx); await settle();
  tree = m.render(cx);
  assert.ok(tabLabel(tree, "tab-c:nonly").endsWith("●"), "a newer note sets the dot again");
});

test("a child's note that is new on the radar opens the panel on its tab; the first sight does not", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.tick(cx); await settle();
  assert.equal(world.runCalls.length, 0, "the first sight of the children's notes does not open the panel");
  assert.notEqual(m.tab, "c:nonly");
  world.shared = { "pi-foreman.radar": radar({ nonly: 2 }) };
  m.tick(cx); await settle();
  assert.equal(m.tab, "c:nonly", "the child's tab is selected");
  assert.equal(m.childPart.get("nonly"), "note", "on its note part");
  assert.ok(world.runCalls.some((c) => c[0] === "layout.show"), "the panel is shown");
  m.tick(cx); assert.equal(world.runCalls.filter((c) => c[0] === "layout.show").length, 1, "an unchanged version does not open it again");
});

test("a click on a child whose read is pending keeps the previous body with a Loading header, then shows the child", async () => {
  reset();
  world.files.hold("/s/n/note.json");
  const { m, cx, settle } = boot(); await settle();
  m.render(cx); await settle();
  assert.ok(!m.recs.get("local|/s/n")?.ready, "the child's read is pending");
  m.tab = "c:nonly";
  let tree = m.render(cx);
  assert.ok(strings(tree).includes("Loading…"), "the header says Loading while the body shows the previous part");
  assert.ok(mds(tree).some((t) => t.includes("RootNote") || t.includes("Alpha body")), "the previous body stays");
  assert.ok(!mds(tree).some((t) => t.includes("NoteOnlyBody")), "the child is not shown before it is read");
  world.files.flush("/s/n/note.json"); await settle();
  tree = m.render(cx);
  assert.ok(!strings(tree).includes("Loading…"), "the indicator goes once the child is ready");
  assert.ok(mds(tree).some((t) => t.includes("NoteOnlyBody")));
});
