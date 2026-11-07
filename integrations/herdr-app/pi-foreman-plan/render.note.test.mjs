import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { sha256 } = await import("./model.js");
const { world } = stubs;

const SVG = '<svg width="120" height="60"><rect x="0" y="0" width="120" height="60" fill="#111"/><text>A</text></svg>';
const FENCE = "A-->B";
const SHA = sha256(FENCE);
const NOTE_MD = `# Note\n\n\`\`\`mermaid\n${FENCE}\n\`\`\`\n\n\`\`\`js\nlet a = 1;\n\`\`\`\n`;
const node = (note) => ({ key: "fm", kind: "session", name: "foreman", hcTerminal: "t1", pid: null, parent: "", state: "working", show: { dir: "/s/fm", plan: 1, note }, children: [] });
const diag = (sha) => ({ sha, dark: `diagrams/${sha}-dark.svg`, light: `diagrams/${sha}-light.svg` });
const noteJson = (o = {}) => JSON.stringify({ title: "Why", v: 1, at: "2026-11-06T10:00:00Z", hash: "n", fences: [SHA], diagrams: [diag(SHA)], ...o });

function reset(note = 1) {
  world.files = new Map([
    ["/s/fm/plan.json", JSON.stringify({ path: "/w/plan-x.md", title: "P", v: 1, at: "2026-11-06T10:00:00Z", hash: "h", ruledPath: null, ruledHash: "", prevHash: "", fences: [] })],
    ["/w/plan-x.md", "# Plan\n"], ["/s/fm/note.json", noteJson()], ["/s/fm/note.md", NOTE_MD],
    [`/s/fm/diagrams/${SHA}-dark.svg`, SVG], [`/s/fm/diagrams/${SHA}-light.svg`, SVG],
  ]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.layout = null;
  world.shared = { "pi-foreman.radar": { machines: { local: [node(note)] } } };
  world.agents = [{ address: "t1", tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: "t1" }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: "t1", shown: null, agent: "t1", cwd: null };
}

function boot() {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return { m, cx, settle };
}
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const bump = (n) => { world.shared = { "pi-foreman.radar": { machines: { local: [node(n)] } } }; };

test("a mermaid fence listed by the harness shows its picture, copied under the app home by sha and theme", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.tab = "note"; m.sync(); m.reload(cx); await settle();
  const els = walk(m.render(cx));
  assert.deepEqual(els.filter((e) => e.kind === "svg").map((e) => e.src), [`mods/pi-foreman-plan/cache/${SHA}-dark.svg`]);
  assert.deepEqual(world.writes.map((w) => w[0]).sort(), [`/app/mods/pi-foreman-plan/cache/${SHA}-dark.svg`, `/app/mods/pi-foreman-plan/cache/${SHA}-light.svg`]);
});

test("a fence whose hash the harness did not list stays a mermaid code block", async () => {
  reset();
  world.files.set("/s/fm/note.json", noteJson({ fences: [], diagrams: [] }));
  const { m, cx, settle } = boot(); await settle();
  m.tab = "note"; m.sync(); m.reload(cx); await settle();
  const els = walk(m.render(cx));
  assert.equal(els.filter((e) => e.kind === "svg").length, 0);
  assert.ok(els.filter((e) => e.kind === "Editor").some((e) => e.state.options.language === "mermaid" && e.state.options.value === FENCE));
  assert.equal(world.writes.length, 0);
});

test("an SVG that fails the allow-list is not cached and the fence falls back to code", async () => {
  reset();
  world.files.set(`/s/fm/diagrams/${SHA}-light.svg`, '<svg><script>x</script></svg>');
  const { m, cx, settle } = boot(); await settle();
  m.tab = "note"; m.sync(); m.reload(cx); await settle();
  const els = walk(m.render(cx));
  assert.equal(els.filter((e) => e.kind === "svg").length, 0);
  assert.ok(els.some((e) => e.kind === "Editor" && e.state.options.language === "mermaid"));
});

test("a diagram entry with a path outside diagrams/<sha>-<theme>.svg is ignored", async () => {
  reset();
  world.files.set("/s/fm/note.json", noteJson({ diagrams: [{ sha: SHA, dark: "../../etc/x.svg", light: `diagrams/${SHA}-light.svg` }] }));
  const { m, cx, settle } = boot(); await settle();
  m.tab = "note"; m.sync(); m.reload(cx); await settle();
  assert.equal(walk(m.render(cx)).filter((e) => e.kind === "svg").length, 0);
  assert.equal(world.writes.length, 0);
});

test("code fences render in a read-only highlighted editor with the fence language", async () => {
  reset();
  const { m, cx, settle } = boot(); await settle();
  m.tab = "note"; m.sync(); m.reload(cx); await settle();
  const ed = walk(m.render(cx)).filter((e) => e.kind === "Editor");
  assert.equal(ed.length, 1);
  assert.deepEqual([ed[0].state.options.language, ed[0].state.options.value, ed[0].state.options.readonly], ["javascript", "let a = 1;", true]);
});

test("a new note on the radar opens the panel on the Note tab; the first sight and an unchanged version do not", async () => {
  reset(1);
  const { m, cx, settle } = boot(); await settle();
  m.tick(cx);
  assert.equal(world.runCalls.length, 0);
  bump(2); m.tick(cx); await settle();
  assert.equal(m.tab, "note");
  assert.deepEqual(world.runCalls, [["layout.select", { stack: "panel-body", child: "plan" }], ["layout.show", { id: "panel" }]]);
  m.tick(cx);
  assert.equal(world.runCalls.length, 2);
});

test("the ids come from the shown layout when it has the block", async () => {
  reset(1);
  world.layout = { id: "root", type: "column", children: [{ id: "side", type: "column", hidden: true, children: [{ id: "tabs", type: "stack", children: [{ id: "pp", type: "block", content: { mod: "pi-foreman-plan" } }] }] }] };
  let b = boot(); await b.settle();
  b.m.tick(b.cx);
  bump(2); b.m.tick(b.cx);
  assert.deepEqual(world.runCalls, [["layout.select", { stack: "tabs", child: "pp" }], ["layout.show", { id: "side" }]]);
});
