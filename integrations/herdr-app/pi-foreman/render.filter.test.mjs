import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { SAMPLE } = await import("./sample.mjs");
const { world } = stubs;

// The Needs-me filter, drawn through the sample view (props `{"sample": true}`): which blocks show, the count line, the toggle.
const SHARED = "pi-foreman.filter";
const saved = { agents: [...SAMPLE.agents], terminals: [...SAMPLE.terminals], spaces: [...SAMPLE.spaces], radar: SAMPLE.radar };
const own = { cost: 0, in: 0, out: 0, uncached: null };
const session = (key, name, over = {}) => ({ key, kind: "session", name, state: "idle", sym: "idle", own, age_s: 120, children: [], waits: [], dots: [], ...over });

function restoreSample() {
  SAMPLE.agents.splice(0, SAMPLE.agents.length, ...saved.agents);
  SAMPLE.terminals.splice(0, SAMPLE.terminals.length, ...saved.terminals);
  SAMPLE.spaces.splice(0, SAMPLE.spaces.length, ...saved.spaces);
  SAMPLE.radar = saved.radar;
}
// Clones the sample radar before a test edits it: the view parses SAMPLE.radar when it is made.
const editRadar = (edit) => { SAMPLE.radar = structuredClone(saved.radar); edit(SAMPLE.radar); };

beforeEach(() => { for (const k of Object.keys(world.shared)) delete world.shared[k]; });
afterEach(restoreSample);

function view(props = { sample: true }) {
  world.props = props;
  const mod = Object.create(Mod.prototype);
  mod.init({}, { timer: { every() {} }, spawn() {}, notify() {} });
  return mod;
}
// Every element of a tree, with the trigger of a HoverCard too (the legend's "?").
const els = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => els(k, out));
  if (el.contentEl) els(el.contentEl, out);
  if (el.props?.trigger) els(el.props.trigger, out);
  return out;
};
const texts = (root) => els(root).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const byId = (root, id) => els(root).find((e) => e.props?.id === id);
const footer = (root) => texts(root).find((s) => / agents · /.test(s));
const hasNeedMe = (root) => texts(root).includes("● Needs me");

// The sample's top rows: busy ones (hidden when the filter is on) and the ones that need you.
const BUSY_HIDDEN = ["sample working", "sample own agents", "sample background", "sample waiting", "sample review", "sample busy calm"];
const NEEDS_YOU = ["sample needs you", "sample done", "sample idle", "sample fleet", "sample three prs", "sample busy asks"];

test("filter off shows every block and no count", () => {
  const texts0 = texts(view().render({}));
  for (const name of [...BUSY_HIDDEN, ...NEEDS_YOU]) assert.ok(texts0.includes(name), name);
  assert.ok(texts0.includes("○ Needs me"));
  assert.equal(footer(view().render({})), "12 agents · 1 need you");
});

test("filter on hides busy blocks (working, agents, bg, waiting) and keeps blocked, idle and done ones", () => {
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  for (const name of BUSY_HIDDEN) assert.ok(!shown.includes(name), `${name} is hidden`);
  for (const name of NEEDS_YOU) assert.ok(shown.includes(name), `${name} is shown`);
  assert.ok(shown.includes("● Needs me"));
});

test("filter on keeps a block with an unknown status", () => {
  SAMPLE.agents.push({ address: "t40", pane: "p-t40", space: 1, space_name: "Sample", tab_name: "sample unknown", status: "weird", program: { name: "pi" }, app: "pi" });
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  assert.ok(shown.includes("sample unknown"));
});

test("a busy parent stays when a child session asks (the sample's sample busy asks)", () => {
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  assert.ok(shown.includes("sample busy asks"));
  assert.ok(shown.includes("asks you"));
});

test("a busy parent stays when one of its agent rows is blocked", () => {
  editRadar((r) => {
    const run = r.roots.find((n) => n.key === "s-own").children[0];
    run.state = "blocked";
    run.sym = "needs-you";
  });
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  assert.ok(shown.includes("sample own agents"));
});

test("a busy top row without a radar node stays when its hc child is blocked", () => {
  SAMPLE.agents.push({ address: "t30", pane: "p-t30", space: 1, space_name: "Sample", tab_name: "sample bare parent", status: "working", program: { name: "pi" }, app: "pi" });
  SAMPLE.terminals.push({ address: "t31", state: "live", parent: "t30", name: "bare child", status: "blocked", agent: "pi" });
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  assert.ok(shown.includes("sample bare parent"));
  assert.ok(shown.includes("bare child"));
});

test("a busy parent stays when a blocked item sits next to a hidden sibling", () => {
  SAMPLE.agents.push({ address: "t41", pane: "p-t41", space: 1, space_name: "Sample", tab_name: "sample masked", status: "working", program: { name: "pi" }, app: "pi" });
  editRadar((r) => r.roots.push(session("s-masked", "sample masked", {
    pid: 321, hcTerminal: "t41", state: "working", sym: "working",
    children: [
      session("s-masked-done", "done child", { state: "done", sym: "done", parent: "s-masked" }),
      session("s-masked-ask", "asks child", { state: "ask", sym: "needs-you", asks: [{ q: "ok?" }], parent: "s-masked" }),
    ],
  })));
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  assert.ok(shown.includes("sample masked"));
  assert.ok(shown.includes("asks child"));
});

test("a busy parent is not kept by idle or done children only", () => {
  const shown = texts(view({ sample: true, needsMe: true }).render({}));
  assert.ok(!shown.includes("sample busy calm"));
  assert.ok(!shown.includes("idle child"));
});

test("the footer counts the hidden blocks after the agent count", () => {
  assert.equal(footer(view({ sample: true, needsMe: true }).render({})), "12 agents · 1 need you · 6 busy hidden");
});

test("with nothing that needs you, one line says so and counts the hidden blocks", () => {
  SAMPLE.agents.splice(0, SAMPLE.agents.length, saved.agents[0]);
  editRadar((r) => { r.roots = []; r.openPrs = []; });
  const root = view({ sample: true, needsMe: true }).render({});
  assert.ok(texts(root).includes("Nothing needs you · 1 busy hidden"));
  assert.ok(!texts(root).includes("No agent status yet."));
  assert.equal(footer(root), "1 agents · 0 need you · 1 busy hidden");
});

test("a space header is hidden when all its members are hidden", () => {
  SAMPLE.spaces.push({ id: 2, machine: null });
  SAMPLE.agents[0] = { ...saved.agents[0], space: 2, space_name: "Second space" };
  assert.ok(texts(view({ sample: true }).render({})).includes("Second space"), "shown with the filter off");
  assert.ok(!texts(view({ sample: true, needsMe: true }).render({})).includes("Second space"), "hidden with the filter on");
});

test("Open PRs is the same with the blocks hidden", () => {
  const openOf = (root) => { const all = texts(root); return all.slice(all.indexOf("Open PRs"), all.findIndex((s) => / agents · /.test(s))); };
  const off = openOf(view({ sample: true }).render({}));
  const on = openOf(view({ sample: true, needsMe: true }).render({}));
  assert.ok(off.includes("acme/widgets"));
  assert.deepEqual(on, off);
});

test("clicking the chip stores the filter app-global, not from render", () => {
  const mod = view();
  let root = mod.render({});
  assert.equal(world.shared[SHARED], undefined, "render stores nothing");
  byId(root, "needs-me").props.on_click(null, { notify() {} });
  assert.deepEqual(world.shared[SHARED], { needsMe: true });
  root = mod.render({});
  assert.ok(hasNeedMe(root));
  byId(root, "needs-me").props.on_click(null, { notify() {} });
  assert.deepEqual(world.shared[SHARED], { needsMe: false });
});

test("the initial state is read from the shared value", () => {
  world.shared[SHARED] = { needsMe: true };
  const root = view().render({});
  assert.ok(hasNeedMe(root));
  assert.ok(!texts(root).includes("sample working"), "busy block hidden");
  assert.ok(footer(root).endsWith("6 busy hidden"));
});

test("the active chip keeps its fill, the resting one has none", () => {
  const on = byId(view({ sample: true, needsMe: true }).render({}), "needs-me");
  const off = byId(view({ sample: true, needsMe: false }).render({}), "needs-me");
  assert.equal(on.props.bg, "#raised");
  assert.equal(off.props.bg, undefined);
});

test("the three title-bar pills carry a border at rest", () => {
  const root = view().render({});
  const legend = els(root).find((e) => e.props?.id === "legend-open");
  for (const pill of [byId(root, "needs-me"), legend, byId(root, "plan-open")]) {
    assert.equal(pill.props.border, 1, `${pill.props.id} border`);
    assert.equal(pill.props.border_color, "#border", `${pill.props.id} border colour`);
  }
});
