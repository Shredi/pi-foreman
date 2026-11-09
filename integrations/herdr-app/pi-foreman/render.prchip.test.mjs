import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { prCard, prStateText, chipPrs } = await import("./model.js");
const { sess, treeOf } = await import("./fixtures.mjs");

const dot = (n, state) => ({ n, state, label: `#${n}`, src: "pr", name: "ci" });

function render(root) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: [root], openPrs: [], tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  return mod.render({});
}
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const cards = (el) => walk(el).filter((e) => e.kind === "HoverCard");
const chipTexts = (el) => cards(el).flatMap((c) => texts(c.props.trigger)).filter((s) => s.startsWith("⎇"));

const tree = (rootDots, kidDots) => treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", dots: rootDots }, [sess("k", "kid", { hcTerminal: "t9", dots: kidDots })]));

test("a top-level and a child row carry their chip in the title row, none on a line below", () => {
  const out = render(tree([dot(16, "ok")], [dot(21, "fail")]));
  const rows = walk(out).filter((e) => /^(row:|agent:t5$)/.test(String(e.props?.id ?? "")));
  const withChip = rows.filter((r) => cards(r).length > 0);
  assert.equal(withChip.length, 2, "both session rows hold a chip");
  assert.deepEqual(withChip.flatMap((r) => chipTexts(r)).sort(), ["⎇ #16", "⎇ #21"]);
  assert.equal(cards(out).length, 2, "no chip anywhere else");
  assert.ok(!texts(out).some((s) => /\d+ PRs?\b/.test(s)), "no summary line");
});

test("several PRs: one chip of the most urgent PR with the count of the others, the same on both kinds of row", () => {
  const three = [dot(1, "ok"), dot(2, "fail"), dot(3, "ok")];
  const out = render(tree(three, three));
  const chips = cards(out);
  assert.equal(chips.length, 2);
  assert.deepEqual(chipTexts(out), ["⎇ #2 +2", "⎇ #2 +2"]);
  assert.deepEqual(chipPrs([{ number: 1, checks: ["ok"] }, { number: 2, checks: ["fail"] }, { number: 3, checks: ["ok"] }]).more.map((p) => p.number), [3, 1]);
});

test("two PRs stay two chips", () => {
  const out = render(tree([dot(1, "ok"), dot(2, "fail")], []));
  assert.deepEqual(chipTexts(out), ["⎇ #2", "⎇ #1"]);
});

test("the hover card names the dot's state and the PR number", () => {
  const states = { fail: "CI failing", run: "CI running", ok: "CI passing", none: "no CI checks" };
  for (const [state, text] of Object.entries(states)) {
    const pr = { number: 16, checks: state === "none" ? [] : [state === "run" ? "pending" : state] };
    assert.equal(prStateText(pr), text, state);
    assert.equal(prCard(pr).state, `#16 · ${text}`, state);
  }
  const out = render(tree([dot(16, "fail")], []));
  assert.ok(cards(out).some((c) => texts(c.contentEl ?? c).includes("#16 · CI failing")), "the card shows it");
});
