import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

// A session with more PRs than INLINE_MAX draws one Open PRs line per PR below its row; two PRs stay chips on the row.
const H1 = "1111111111111111111111111111111111111111";
const ok = [{ n: "ci", state: "ok" }];
const entry = (number, over = {}) => ({ number, repo: "acme/app", title: `PR ${number}`, url: `https://example.test/acme/app/pull/${number}`, state: "open", head: H1, mergeState: "clean", mergeable: "MERGEABLE", headRefName: "feat", checks: ok, ...over });
const dot = (number, state) => ({ n: number, state, label: `#${number}`, src: "pr", url: `https://example.test/acme/app/pull/${number}` });
const OPEN = [
  entry(201), // ready
  entry(202, { checks: [{ n: "lint", state: "fail" }] }), // red
  entry(203, { mergeState: "blocked" }), // merge blocked
];
const AGENT = { address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } };

function view(roots, openPrs = OPEN) {
  world.agents = [AGENT];
  world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const d = parseRadarDoc(JSON.stringify({ v: 1, openPrsAt: new Date().toISOString(), roots, openPrs }));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set();
  m.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), tried: Date.now(), openPrs: d.openPrs, openPrsAt: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
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
const hasText = (el, text) => (el.kids ?? []).includes(text);
const cards = (el) => walk(el).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");
// The line (or chip) of PR `n`: the HoverCard whose trigger draws "⎇ #n".
const lineOf = (root, n) => cards(root).find((c) => walk(c.props.trigger).some((e) => hasText(e, `⎇ #${n}`)));
const checkOf = (line) => walk(line.props.trigger).find((e) => hasText(e, "✓"));
const discOf = (line) => walk(line.props.trigger).find((e) => e.props.size === 6);

test("a ready PR beside a red one in one session: both lines, each with its own state", () => {
  const root = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots: [dot(201, "ok"), dot(202, "fail"), dot(203, "ok")] })]).render({});
  const ready = lineOf(root, 201);
  const red = lineOf(root, 202);
  assert.ok(ready, "#201 has a line");
  assert.ok(red, "#202 has a line");
  assert.equal(checkOf(ready).props.text_color, "#ansi2", "the ready line has the ready mark");
  assert.equal(discOf(ready), undefined, "and no disc");
  assert.notEqual(ready.props.trigger.props.text_color, "#blocked", "the ready number is not red");
  assert.equal(checkOf(red), undefined, "the red line has no ready mark");
  assert.equal(discOf(red).props.bg, "#blocked", "the red line has the red disc");
  assert.equal(red.props.trigger.props.text_color, "#blocked", "the red line's number is red");
  assert.ok(lineOf(root, 203), "the merge-blocked PR is a line too");
  assert.ok(texts(red.props.trigger).includes("PR 202"), "the line carries the title");
});

test("more than two PRs: no \"#n +k\" text anywhere, and no chip on the session's title row", () => {
  const root = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots: [dot(201, "ok"), dot(202, "fail"), dot(203, "ok")] })]).render({});
  assert.ok(!walk(root).some((e) => (e.kids ?? []).some((k) => typeof k === "string" && /\+\d/.test(k))), "no +k text");
  const rows = walk(root).filter((e) => /^(row:|agent:t5$)/.test(String(e.props?.id ?? "")));
  assert.equal(rows.filter((r) => r.kids?.some((k) => k.kind === "HoverCard")).length, 0, "the title row holds no chip");
  assert.equal(cards(root).length, 3, "three lines, one per PR");
});

test("a two-PR session draws two lines below the row, none on the title row", () => {
  const root = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots: [dot(201, "ok"), dot(202, "fail")] })], OPEN.slice(0, 2)).render({});
  const rows = walk(root).filter((e) => /^(row:|agent:t5$)/.test(String(e.props?.id ?? "")));
  assert.equal(rows.flatMap((r) => (r.kids ?? []).filter((k) => k.kind === "HoverCard")).length, 0, "no chip on the row");
  assert.deepEqual(cards(root).map((c) => walk(c.props.trigger).find((e) => /^⎇/.test(e.kids?.[0] ?? ""))?.kids[0]), ["⎇ #202", "⎇ #201"], "failing first, as lines");
});

test("hovering a session line builds its card; a click opens its page", () => {
  const m = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots: [dot(201, "ok"), dot(202, "fail"), dot(203, "ok")] })]);
  let root = m.render({});
  const ev = { bounds: { width: 40, height: 16 }, position: { x: 100, y: 200 }, local_position: { x: 5, y: 5 } };
  lineOf(root, 202).props.trigger.props.on_mouse_move(ev, { notify() {} });
  root = m.render({});
  const card = lineOf(root, 202);
  assert.ok(texts(card.contentEl).includes("#202 · CI failing"), "the card names the state");
  assert.ok(texts(card.contentEl).includes("PR 202"), "and the title");

  const opened = [];
  m.openUrl = (url) => opened.push(url);
  lineOf(root, 202).props.trigger.props.on_click({}, { stop_propagation() {}, notify() {}, spawn() {} });
  assert.deepEqual(opened, ["https://example.test/acme/app/pull/202"]);
});

test("a child card with more than two PRs draws its lines inside the card", () => {
  const root = view([sess("s-p", "agent-a", { pid: 7, hcTerminal: "t5" }, [sess("k", "kid", { hcTerminal: "t9", dots: [dot(201, "ok"), dot(202, "fail"), dot(203, "ok")] })])]).render({});
  assert.equal(cards(root).length, 3, "three lines of the child");
  assert.ok(lineOf(root, 202), "the red line is drawn");
  assert.ok(!walk(root).some((e) => (e.kids ?? []).some((k) => typeof k === "string" && /\+\d/.test(k))), "no +k text");
});
