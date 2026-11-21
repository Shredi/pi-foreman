import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { SAMPLE_MANY } = await import("./sample.mjs");

const cx = { timer: { every() {} }, spawn() {}, notify() {} };

function view(props) {
  stubs.world.props = props;
  stubs.world.execCalls = [];
  stubs.world.agentOrder = [];
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  return m;
}
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const lines = (root) => walk(root).filter((e) => e.kind === "HoverCard" && texts(e.props.trigger).some((s) => /^#2\d\d$/.test(s)));
const heads = (root) => walk(root).filter((e) => /^oph-/.test(String(e.props?.id ?? "")));

test("manyPrs without sample changes nothing", () => {
  const m = view({ manyPrs: true });
  assert.equal(m.sample, false);
  assert.equal(m.manyPrs, true);
  assert.equal(m.radar.size, 0, "no sample radar is loaded");
  const plain = view({ sample: true });
  assert.equal(plain.manyPrs, false);
  assert.equal(lines(plain.render({})).length, 0, "the legend sample draws none of the 2xx PRs");
});

test("sample + manyPrs: 52 PRs in 18 groups; all groups opened draw 52 lines; neutral names only", () => {
  const m = view({ sample: true, manyPrs: true });
  assert.equal(SAMPLE_MANY.radar.openPrs.length, 52);
  let root = m.render({});
  assert.equal(heads(root).length, 18);
  m.unfolded = new Set(heads(root).map((h) => `opg:${h.props.id.slice("oph-".length)}`));
  root = m.render({});
  assert.equal(lines(root).length, 48, "the failing group of 12 is capped at 8 lines (+4 more)");
  m.expanded = new Set(["acme/romeo"]);
  root = m.render({});
  const drawn = lines(root);
  assert.equal(drawn.length, 52);
  assert.deepEqual(drawn.map((c) => texts(c.props.trigger).find((s) => /^#/.test(s))).sort(), Array.from({ length: 52 }, (_, i) => `#${201 + i}`).sort());
  const names = JSON.stringify(SAMPLE_MANY);
  assert.ok(!/herdr|pi-foreman|marc|meixner/i.test(names), "no real names");
  assert.ok(/example\.test/.test(names));
});

test("sample + manyPrs: attention groups start open, the rest folded; #206 is unreviewed, #211 has no title, #219 no page", () => {
  const root = view({ sample: true, manyPrs: true }).render({});
  const open = lines(root);
  assert.ok(open.length > 0 && open.length < 40);
  const nums = open.map((c) => texts(c.props.trigger).find((s) => /^#/.test(s)));
  assert.ok(nums.includes("#206") && !nums.includes("#207"), "a conflict group is open, a plain group folded");
  assert.ok(walk(open.find((c) => texts(c.props.trigger).includes("#206")).props.trigger).some((e) => e.props?.bg === "#ansi42e" && e.props.text_color === "#ansi4"), "#206 has the blue badge");
  // the groups fold by their order: failing and conflict groups first
  assert.match(texts(heads(root)[0]).join(" "), /failing|conflict/);
});

test("sample + manyPrs: a line without a title has none, a line without a page address gives the notice", () => {
  const m = view({ sample: true, manyPrs: true });
  let root = m.render({});
  m.unfolded = new Set(heads(root).map((h) => `opg:${h.props.id.slice("oph-".length)}`));
  root = m.render({});
  const line = (n) => lines(root).find((c) => texts(c.props.trigger).includes(`#${n}`));
  assert.ok(!texts(line(211).props.trigger).some((s) => /^Sample change/.test(s) || s === ""));
  assert.ok(texts(line(210).props.trigger).includes("Sample change 210"));
  stubs.world.notices = [];
  line(219).props.trigger.props.on_click({}, { stop_propagation() {}, notify() {}, spawn() {} });
  assert.equal(stubs.world.notices.length, 1);
});
