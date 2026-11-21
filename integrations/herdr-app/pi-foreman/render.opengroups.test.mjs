import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc } = await import("./model.js");

const OK = [{ n: "build", state: "ok" }];
const KINDS = {
  ok: {},
  fail: { checks: [{ n: "build", state: "ok" }, { n: "lint", state: "fail" }, { n: "e2e", state: "pending" }] },
  conflict: { mergeable: "CONFLICTING", mergeState: "dirty" },
  run: { checks: [{ n: "ci", state: "pending" }] },
};

// `spec`: [repo, number, kind, extra]; neutral example names. `unreviewed`: numbers (repo `example-org/<repo>` of the spec) that an unshown session
// watches past the last review, the only source of the blue dot.
function docOf(spec, unreviewed = []) {
  const openPrs = spec.map(([repo, n, kind = "ok", extra = {}]) => ({
    repo: `example-org/${repo}`, number: n, title: `Change ${n}`, state: "open", headRefName: `feat/${n}`, mergeable: "MERGEABLE", mergeState: "clean",
    url: `https://example.test/example-org/${repo}/pull/${n}`, checks: OK, ...KINDS[kind], ...extra,
  }));
  const own = { cost: 0, in: 0, out: 0 };
  const roots = unreviewed.map((n, i) => {
    const [repo] = spec.find((s) => s[1] === n);
    const ref = { n, repo: `example-org/${repo}` };
    return { key: `s${i}`, kind: "session", name: `s${i}`, state: "idle", sym: "idle", own, tot: own, age_s: 100, children: [], repoUrl: `https://example.test/example-org/${repo}`,
      dots: [{ n, state: "ok", label: `#${n}`, src: "pr", url: `https://example.test/example-org/${repo}/pull/${n}` }],
      waits: [{ kind: "pr", note: "1 pr watch", age_s: 5, prs: [n], prRefs: [ref], unreviewed: [ref], review: [{ ...ref, head: "1".repeat(40), state: "unreviewed" }] }] };
  });
  return parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs, openPrsAt: "2026-11-17T10:00:00Z" }));
}

// Like the other render tests: no constructor, only `folded` set, so the lazy fold state of openPrRows is exercised.
function mod(doc) {
  stubs.world.agents = [];
  stubs.world.terminals = [];
  stubs.world.notices = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: doc.nodes, openPrs: doc.openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set();
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
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const fullCards = (root) => cards(root).filter((c) => texts(c.contentEl).length > 0);
const cardOf = (root, n) => cards(root).find((c) => texts(c.props.trigger).includes(`#${n}`));
const groupId = (e) => /^op-example-org\//.exec(String(e.props?.id ?? ""));
const groups = (root) => walk(root).filter(groupId);
const group = (root, repo) => groups(root).find((g) => g.props.id === `op-example-org/${repo}`);
const head = (root, repo) => walk(root).find((e) => e.props?.id === `oph-example-org/${repo}`);
const order = (root) => groups(root).map((g) => g.props.id.slice("op-example-org/".length));
const chevron = (root, repo) => walk(head(root, repo)).find((e) => e.kind === "svg");
const noMore = (root) => !walk(root).some((e) => /^op-more-/.test(String(e.props?.id ?? "")) || texts(e).some((s) => /\+\d+ more/.test(s)));

// The host bubbles a click from the clicked element up through its parents, until a handler calls stop_propagation. The stubs do not.
function pathTo(root, target) {
  const find = (el, up) => {
    if (!el || typeof el !== "object") return null;
    if (el === target) return [...up, el];
    const next = [...up, el];
    for (const k of [...(el.kids ?? []), el.contentEl, el.kind === "HoverCard" ? el.props.trigger : null]) {
      const hit = find(k, next);
      if (hit) return hit;
    }
    return null;
  };
  return find(root, []);
}
function click(root, target, cx = {}) {
  const chain = pathTo(root, target);
  assert.ok(chain, "the clicked element is in the tree");
  let stopped = false;
  const bx = { notify() {}, spawn() {}, ...cx, stop_propagation() { stopped = true; } };
  let calls = 0;
  for (const el of chain.reverse()) {
    if (typeof el.props?.on_click !== "function") continue;
    calls++;
    el.props.on_click({}, bx);
    if (stopped) break;
  }
  return calls;
}

test("the click helper bubbles up to every parent, and stops where stop_propagation is called", () => {
  let n = 0;
  const bump = () => { n++; };
  const mk = (stop) => {
    const inner = stubs.make("h_flex").on_click((_e, cx) => { bump(); if (stop) cx.stop_propagation(); });
    const outer = stubs.make("h_flex").on_click(bump).child(inner);
    return { inner, outer };
  };
  const a = mk(false);
  assert.equal(click(a.outer, a.inner), 2, "chevron and heading both carrying a toggle: two toggles");
  assert.equal(n, 2);
  const b = mk(true);
  assert.equal(click(b.outer, b.inner), 1);
  assert.equal(n, 3);
});

const MIXED = [
  ["alpha", 1, "ok"], ["alpha", 2, "fail"], ["alpha", 3, "fail"], ["alpha", 4, "conflict"], ["alpha", 5, "ok"], ["alpha", 6, "ok"], ["alpha", 7, "ok"],
  ["bravo", 11, "ok"],
];

test("one heading per repository with its PR count, failing count and conflict count; 1 PR in the singular", () => {
  const root = mod(docOf(MIXED)).render({});
  assert.deepEqual(order(root).sort(), ["alpha", "bravo"]);
  assert.deepEqual(texts(head(root, "alpha")), ["example-org/alpha", "7 PRs", " · 2 failing", " · 1 conflict"]);
  assert.deepEqual(texts(head(root, "bravo")), ["example-org/bravo", "1 PR"]);
  const two = mod(docOf([["alpha", 1, "conflict"], ["alpha", 2, "conflict"]])).render({});
  assert.deepEqual(texts(head(two, "alpha")), ["example-org/alpha", "2 PRs", " · 2 conflicts"]);
});

test("one line per PR: a HoverCard with the number and the title; no +k more anywhere", () => {
  const root = mod(docOf(MIXED)).render({});
  assert.equal(cards(root).length, 8);
  for (const [, n] of MIXED) {
    const c = cardOf(root, n);
    assert.ok(c, `#${n}`);
    assert.ok(texts(c.props.trigger).includes(`Change ${n}`), `title of #${n}`);
  }
  assert.ok(noMore(root));
  // the state is the badge's colour; every title, failing or not, is in the normal foreground
  assert.equal(walk(cardOf(root, 2).props.trigger).find((e) => e.kids?.includes("#2")).props.text_color, "#blocked");
  assert.equal(walk(cardOf(root, 2).props.trigger).find((e) => e.kids?.includes("Change 2")).props.text_color, "#foreground");
  assert.equal(walk(cardOf(root, 5).props.trigger).find((e) => e.kids?.includes("Change 5")).props.text_color, "#foreground");
  assert.ok(texts(cardOf(root, 4).props.trigger).includes("!"), "the conflict mark");
});

test("groups with a failing check or a conflict come first; blue, amber and ready groups follow in the given order", () => {
  const spec = [["a-ready", 1, "ok"], ["b-run", 2, "run"], ["c-blue", 3, "ok"], ["d-conflict", 4, "conflict"], ["e-ready", 5, "ok"], ["f-fail", 6, "fail"], ["g-fail", 7, "fail"]];
  const root = mod(docOf(spec, [3])).render({});
  const names = order(root);
  assert.deepEqual(names.slice(0, 3).sort(), ["d-conflict", "f-fail", "g-fail"]);
  const rest = names.slice(3);
  assert.deepEqual(rest.filter((r) => r !== "c-blue"), ["a-ready", "b-run", "e-ready"].filter((r) => rest.includes(r)), "the others keep their relative order");
  assert.ok(walk(cardOf(root, 3).props.trigger).some((e) => e.props?.bg === "#ansi42e"), "#3 is drawn blue");
  assert.ok(!texts(head(root, "c-blue")).some((s) => /failing|conflict/.test(s)), "a blue PR does not count as attention");
});

test("with 15 PRs or fewer every group is open; with more, only groups with a failing check or a conflict are", () => {
  const few = mod(docOf([["alpha", 1, "ok"], ["bravo", 2, "ok"]])).render({});
  assert.equal(cards(few).length, 2);
  const flat = (n, kind) => Array.from({ length: n }, (_, i) => ["alpha", 100 + i, kind]);
  assert.equal(cards(mod(docOf(flat(15, "ok"))).render({})).length, 15, "15 is not more than 15");
  assert.equal(cards(mod(docOf(flat(16, "ok"))).render({})).length, 0, "16: folded");
  const spec = [...flat(10, "ok"), ["bravo", 200, "fail"], ["bravo", 201, "ok"], ["charlie", 300, "conflict"], ["delta", 400, "run"], ["delta", 401, "ok"], ["delta", 402, "ok"], ["delta", 403, "ok"]];
  const root = mod(docOf(spec)).render({});
  assert.equal(cards(group(root, "alpha")).length, 0);
  assert.equal(cards(group(root, "delta")).length, 0);
  assert.equal(cards(group(root, "bravo")).length, 2);
  assert.equal(cards(group(root, "charlie")).length, 1);
  const blue = mod(docOf([...flat(15, "ok"), ["blue", 500, "ok"]], [500])).render({});
  assert.equal(cards(group(blue, "blue")).length, 0, "an unreviewed-only group is folded");
});

test("the heading opens a folded group exactly once per click; a re-render keeps it; the chevron follows the shown state", () => {
  const spec = Array.from({ length: 16 }, (_, i) => ["alpha", 100 + i, "ok"]);
  const m = mod(docOf(spec));
  let root = m.render({});
  assert.equal(cards(root).length, 0);
  const closed = chevron(root, "alpha").src;
  assert.equal(click(root, chevron(root, "alpha")), 1, "one toggle per click on the chevron");
  root = m.render({});
  assert.equal(cards(root).length, 16);
  assert.notEqual(chevron(root, "alpha").src, closed, "the chevron turns when open");
  assert.equal(cards(m.render({})).length, 16, "a re-render keeps it open");
});

test("the heading folds an open group; it stays folded after the PR count drops to 15 or fewer", () => {
  const spec = [["alpha", 1, "fail"], ...Array.from({ length: 15 }, (_, i) => ["bravo", 100 + i, "ok"])];
  const m = mod(docOf(spec));
  let root = m.render({});
  assert.equal(cards(group(root, "alpha")).length, 1, "attention group open");
  assert.equal(click(root, head(root, "alpha")), 1);
  root = m.render({});
  assert.equal(cards(group(root, "alpha")).length, 0);
  m.radar.get("local").openPrs = docOf(spec.slice(0, 10)).openPrs;
  root = m.render({});
  assert.equal(cards(group(root, "alpha")).length, 0, "stays folded");
  assert.equal(cards(group(root, "bravo")).length, 9, "the other group is open at 10 PRs");
});

test("a line opens its page on click; a line without a page address says so and starts no opener", () => {
  const m = mod(docOf([["alpha", 1, "ok"], ["alpha", 2, "ok", { url: "" }]]));
  const opened = [];
  m.openUrl = (url) => opened.push(url);
  let spawned = 0;
  const root = m.render({});
  click(root, cardOf(root, 1).props.trigger, { spawn() { spawned++; } });
  assert.deepEqual(opened, ["https://example.test/example-org/alpha/pull/1"]);
  click(root, cardOf(root, 2).props.trigger, { spawn() { spawned++; } });
  assert.deepEqual(opened.length, 1, "no opener for the line without a page");
  assert.equal(spawned, 0);
  assert.equal(stubs.world.notices.length, 1);
  assert.equal(stubs.world.notices[0].title, "No link for this pull request");
  assert.equal(stubs.world.notices[0].body, "#2 has no page address yet.");
});

test("hovering a line builds its card with the jobs, and only that line's card, also after a second render", () => {
  const m = mod(docOf([["alpha", 1, "fail"], ["alpha", 2, "fail"], ["alpha", 3, "ok"]]));
  const cx = { n: 0, notify() { cx.n++; } };
  const ev = { bounds: { width: 40, height: 16 }, position: { x: 100, y: 200 }, local_position: { x: 5, y: 5 } };
  cardOf(m.render({}), 1).props.trigger.props.on_mouse_move(ev, cx);
  for (let i = 0; i < 2; i++) {
    const root = m.render({});
    assert.deepEqual(fullCards(root).map((c) => c.props.trigger.props.id), [cardOf(root, 1).props.trigger.props.id]);
    const t = texts(cardOf(root, 1).contentEl);
    assert.ok(t.includes("Change 1") && t.includes("lint") && t.includes("build") && t.includes("e2e"), "title and jobs failed, passed, running");
  }
});

test("a group without a PR list falls back to its plain row; the healthy groups and the section stay", () => {
  const t = stubs.theme();
  const m = mod(docOf([]));
  const rows = Mod.prototype.openPrRows.call(m, t, [{ repo: "example-org/broken", prs: null }, { repo: "example-org/alpha", prs: [{ number: 1, title: "Change 1", href: "https://example.test/x", checks: OK }] }]);
  assert.equal(rows[0].props.id, "op-head", "the section is there");
  const broken = rows.find((r) => r.props.id === "op-example-org/broken");
  assert.deepEqual(texts(broken), ["example-org/broken", "0 PRs"]);
  const good = rows.find((r) => r.props.id === "op-example-org/alpha");
  assert.equal(cards(good).length, 1);
});

test("a PR without a title renders its line without a title element", () => {
  const root = mod(docOf([["alpha", 1, "ok", { title: "" }], ["alpha", 2, "ok"]])).render({});
  assert.deepEqual(texts(cardOf(root, 1).props.trigger).filter((s) => /^Change|^$/.test(s)), []);
  assert.ok(texts(cardOf(root, 2).props.trigger).includes("Change 2"));
  assert.ok(!walk(cardOf(root, 1).props.trigger).some((e) => e.props?.truncate !== undefined && e.props.min_w === 0));
});

test("a session row's fold slot without the state argument still toggles on its own click", () => {
  const m = mod(docOf([]));
  const t = stubs.theme();
  let notified = 0;
  const slot = m.foldSlot(t, "row-1", true);
  slot.props.on_click({}, { notify() { notified++; } });
  assert.ok(m.folded.has("row-1"));
  slot.props.on_click({}, { notify() { notified++; } });
  assert.ok(!m.folded.has("row-1"));
  assert.equal(notified, 2);
  assert.equal(m.foldSlot(t, "row-2", true, { folded: true }).props.on_click, undefined, "with the state argument the slot has no click of its own");
});

test("a chip without a line option is a list line too, not a pill: full width, no border, no fill", () => {
  const m = mod(docOf([]));
  const t = stubs.theme();
  const pr = { number: 7, title: "Change 7", checks: [{ n: "lint", state: "fail" }], state: "open", mergeable: "MERGEABLE" };
  const chip = m.prChip(t, pr, "https://example.test/x/pull/7", "k");
  const p = chip.props.trigger.props;
  assert.equal(chip.props.trigger.kind, "h_flex");
  assert.deepEqual([p.h, p.px, p.rounded, p.border, p.bg, p.text_color, p.w_full], [18, 4, 4, undefined, undefined, "#muted", true]);
  assert.deepEqual(texts(chip.props.trigger), ["#7"]);
});

test("lines with and without a conflict or an unreviewed head share one structure up to the title; an unreviewed PR has no token, only the blue dot", () => {
  const spec = [["alpha", 1, "ok"], ["alpha", 2, "conflict"], ["alpha", 3, "ok"]];
  const root = mod(docOf(spec, [3])).render({});
  const kidsOf = (n) => cardOf(root, n).props.trigger.kids;
  for (const n of [1, 2, 3]) {
    const [num, marks, title] = kidsOf(n);
    assert.equal(num.props.w, 60, `#${n} number cell`);
    assert.equal(marks.props.w, 11, `#${n} conflict slot has a fixed width`);
    assert.equal(marks.props.flex_none, true);
    assert.equal(marks.kids.length, 1, `#${n}: the conflict slot only`);
    assert.equal(marks.kids[0].props.size === 11 || marks.kids[0].kids?.[0] === "!", true, `#${n}: the slot has the mark's width`);
    assert.deepEqual(texts(title), [`Change ${n}`], `#${n}: the title is the third element`);
  }
  assert.deepEqual(texts(kidsOf(2)[1]), ["!"]);
  assert.equal(kidsOf(1).length, 3);
  assert.equal(kidsOf(2).length, 3);
  assert.equal(kidsOf(3).length, 3, "no token behind the title");
  assert.ok(!texts(root).includes("unreviewed head"));
  assert.ok(walk(kidsOf(3)[0]).some((e) => e.props?.bg === "#ansi42e" && e.props.text_color === "#ansi4"), "the blue badge");
});
