import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const PB = "/w/plan-b.md";
const meta = (path) => JSON.stringify({ path, title: "P", v: 1, at: "2026-11-06T10:00:00Z", hash: "h", ruledPath: null, prevHash: null, fences: [] });
const note = JSON.stringify({ title: "Why", v: 1, at: "2026-11-06T10:00:00Z", hash: "n1", fences: [], diagrams: [] });
const sess = (key, hc, show, parent = "") => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent, state: "working", ...(show ? { show } : {}), children: [] });

function reset() {
  world.files = new Map([
    ["/s/fm/plan.json", meta("/w/plan-a.md")], ["/w/plan-a.md", "# Plan A\n\nAlpha.\n"],
    ["/s/b/plan.json", meta(PB)], [PB, "# Plan B\n\nBothPlan.\n"], ["/s/b/note.json", note], ["/s/b/note.md", "# Both note\n\nBothNote.\n"],
  ]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null; world.execCalls = [];
  world.shared = { "pi-foreman.radar": { machines: { local: [
    sess("fm", "t1", { dir: "/s/fm", plan: 1 }),
    sess("both", "tc2", { dir: "/s/b", plan: 1, note: 1 }, "fm"),
  ] } } };
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
const label = (el, id) => strings(byId(el, id) ?? { kids: [] }).join("");
const dotted = (el, id) => label(el, id).includes("●");

test("a two-part child: tab dot off while shown, switch dot on the unseen part, cleared once shown, tab dot back when left", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tick(cx); await settle();
  let tree = m.render(cx);
  assert.ok(dotted(tree, "tab-c:both"), "unseen while another tab is on screen");
  m.tab = "c:both"; m.render(cx); await settle();
  tree = m.render(cx);
  assert.ok(mds(tree).some((t) => t.includes("BothPlan")));
  assert.ok(!dotted(tree, "tab-c:both"), "no dot on the tab while it is on screen");
  assert.ok(!dotted(tree, "part-plan"), "the shown part has no dot");
  assert.ok(dotted(tree, "part-note"), "the unseen note part carries its own dot");
  byId(tree, "part-note").props.on_click(null, cx);
  tree = m.render(cx);
  assert.ok(mds(tree).some((t) => t.includes("BothNote")));
  assert.ok(!dotted(tree, "part-note") && !dotted(tree, "part-plan"), "the switch dot clears once the part is shown");
  assert.ok(!dotted(tree, "tab-c:both"));
  // plan was seen and note is seen now: leaving the tab leaves no dot; a newer plan brings it back
  m.tab = "plan"; m.render(cx); await settle();
  tree = m.render(cx);
  assert.ok(!dotted(tree, "tab-c:both"), "both parts seen: no dot after leaving");
});

test("leaving a two-part child with a part still unseen brings the tab dot back", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.tick(cx); await settle();
  m.tab = "c:both"; m.render(cx); await settle();
  let tree = m.render(cx);
  assert.ok(!dotted(tree, "tab-c:both"));
  m.tab = "plan"; m.render(cx); await settle();
  tree = m.render(cx);
  assert.ok(dotted(tree, "tab-c:both"), "the note was never shown: the dot returns on leaving");
});

test("a plan pin on a child last on Note shows the plan; a note pin shows the note", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.render(cx);
  m.childPart.set("both", "note");
  world.shared["pi-foreman.show"] = { n: 1, key: "both", kind: "plan" };
  m.sync();
  assert.equal(m.cur.tab.id, "c:both");
  assert.equal(m.cur.part, "plan", "the plan pin selects the plan part");
  world.shared["pi-foreman.show"] = { n: 2, key: "both", kind: "note" };
  m.sync();
  assert.equal(m.cur.part, "note", "the note pin selects the note part");
  m.render(cx); await settle();
  assert.ok(mds(m.render(cx)).some((t) => t.includes("BothNote")));
});
