import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { sessionTree, statusLine } = await import("./model.js");
const { sess, run, treeOf } = await import("./fixtures.mjs");

const dots = (...ns) => ns.map((n) => ({ n, state: n % 2 ? "fail" : "run", src: "pr", name: "ci" }));
const wait = (note) => ({ kind: "ci", note, age_s: 29 });

// One paned agent t5 whose joined radar node is `root`.
function render(root, focused = false) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused, program: { name: "pi" } }];
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
  return out;
};
const byId = (root, prefix) => walk(root).filter((e) => String(e.props.id ?? "").startsWith(prefix));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

const top = (kids, over = {}) => treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", waits: [wait("1 pr watch")], dots: dots(1, 2, 3), ...over }, kids));

test("(a) a root with a status line and chips: the connector runs through every row before the first child", () => {
  const root = render(top([sess("k", "kid", { hcTerminal: "t9" })]));
  const rails = byId(root, "rail:f/").map((e) => e.props.id);
  assert.deepEqual(rails.filter((r) => r.startsWith("rail:f/x")), ["rail:f/x0", "rail:f/x1"], "status line and chip line");
  assert.ok(byId(root, "rail:agent:t5/row").length === 1, "stub under the root chevron");
  for (const r of byId(root, "rail:f/x")) assert.equal(r.props.left, 16, "same x as the chevron of the root row");
  assert.equal(byId(root, "rail:agent:t5/row")[0].props.left, 16);
  // the child's tee follows at the same x
  assert.ok(byId(root, "conn:elbow:").length + byId(root, "conn:tee:").length >= 1);
});

test("(a) folded, the root has no connector", () => {
  const mod = Object.create(Mod.prototype);
  const t = sessionTree(top([sess("k", "kid")]));
  mod.folded = new Set(["agent:t5"]);
  const rails = mod.extras({}, t, 8, null);
  assert.equal(walk({ kids: rails }).filter((e) => String(e.props?.id ?? "").startsWith("rail:")).length, 0);
});

test("(b) a nested session with its own status line: card rail from its chevron through the line to its child", () => {
  const nested = sess("n", "setup-gui", { hcTerminal: "t9", waits: [wait("1 pr watch")] }, [sess("g", "grandchild", { hcTerminal: "t8" })]);
  const root = render(top([nested]));
  const card = byId(root, "card:").find((e) => e.props.id.endsWith("/s0"));
  assert.ok(card, "nested session card");
  const rails = walk(card).filter((e) => String(e.props.id ?? "").startsWith("rail:"));
  assert.deepEqual(rails.map((e) => e.props.id.split("/").slice(-1)[0]), ["row", "x0"]);
  assert.ok(rails.every((e) => e.props.left === 8), "chevron centre inside the card");
  // the stub below the card and the children's column sit CARD (5) further right: the same line
  const gap = byId(root, "rail:").find((e) => e.props.id.endsWith("/s0/gap"));
  assert.equal(gap.props.left, 13);
  assert.equal(gap.props.top, -1, "stub overlaps the card's bottom border: no 1px gap in the line");
});

test("(c) a lost or closed child session without live children is hidden; a closed parent of a live child stays", () => {
  for (const state of ["lost", "closed"]) {
    const t = sessionTree(treeOf(sess("r", "r", {}, [sess("live", "live", { hcTerminal: "t1" }), sess("planmode-probe", "planmode-probe", { state, sym: state, hcTerminal: "t1x", pid: 60618 })])));
    assert.deepEqual(t.children.map((c) => c.label), ["live"], state);
  }
  const p = sessionTree(treeOf(sess("r", "r", {}, [sess("p", "p", { state: "lost", sym: "lost" }, [sess("kid", "kid", { state: "working", sym: "working" })])])));
  assert.equal(p.children[0].dim, true);
});

test("(d) an agent row carries the robot emoji, not an svg", () => {
  const root = render(top([sess("k", "kid", { hcTerminal: "t9" }, [run("b", "builder")])]));
  const row = byId(root, "row:").find((e) => e.props.id.endsWith("/a0"));
  assert.ok(row);
  assert.ok(texts(row).includes("🤖"));
  assert.ok(!walk(row).some((e) => e.kind === "svg" && /agent/.test(e.src ?? "")));
});

test("(e) every session row is a bordered card, also one without status lines", () => {
  const root = render(top([sess("k", "kid", { hcTerminal: "t9" })], { waits: [], dots: [] }));
  const card = byId(root, "card:").find((e) => e.props.id.endsWith("/s0"));
  assert.ok(card);
  assert.equal(card.props.border, 1);
  assert.equal(card.props.rounded, 6);
  assert.ok(walk(card).some((e) => e.props.id === "row:" + card.props.id.slice(5)), "the row is inside the card");
});

test("(f) a session's own agent rows and their connector sit inside its card; child sessions follow the card", () => {
  const kid = sess("k", "kid", { hcTerminal: "t9", waits: [wait("1 pr watch")] }, [run("b", "builder"), run("c", "tester"), sess("g", "grand", { hcTerminal: "t8" })]);
  const root = render(top([kid]));
  const cards = byId(root, "card:");
  const card = cards.find((e) => e.props.id.endsWith("/s0"));
  const inCard = walk(card).map((e) => e.props.id);
  assert.ok(inCard.some((id) => /^row:.*\/a0$/.test(id)) && inCard.some((id) => /^row:.*\/a1$/.test(id)), "both agent rows inside the card");
  assert.ok(inCard.some((id) => /^conn:tee:.*\/a0$/.test(id)) && inCard.some((id) => /^conn:tee:.*\/a1$/.test(id)), "tees inside the card: the line goes on to the child session");
  assert.equal(walk(card).filter((e) => String(e.props.id ?? "").startsWith("card:")).length, 1, "the child session is no card inside it");
  assert.equal(cards.length, 2, "the kid's card and the child session's card after it; the root is uncarded");
  assert.ok(byId(root, "rail:").some((e) => e.props.id.endsWith("/s0/gap")), "stub below the card");
});

test("(f) agents only: the last agent gets the elbow and there is no stub below the card", () => {
  const kid = sess("k", "kid", { hcTerminal: "t9" }, [run("b", "builder")]);
  const root = render(top([kid]));
  const card = byId(root, "card:").find((e) => e.props.id.endsWith("/s0"));
  const inCard = walk(card).map((e) => e.props.id);
  assert.ok(inCard.some((id) => /^conn:elbow:.*\/a0$/.test(id)));
  assert.ok(inCard.some((id) => /^rail:.*\/row$/.test(id)), "rail from the chevron");
  assert.equal(byId(root, "rail:").filter((e) => e.props.id.endsWith("/s0/gap")).length, 0);
});

test("(g) the selection sits on the card (bg + accent border), not on its header row; the root keeps its row fill", () => {
  const mod = Object.create(Mod.prototype);
  mod.folded = new Set(); mod.changed = {}; mod.radar = new Map(); mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  const kid = sessionTree(top([sess("k", "kid", { hcTerminal: "t9" }, [run("b", "builder")])])).children[0];
  const t = stubs.theme();
  kid.address = "t9";
  const cardOf = (shown) => { mod.shown = shown; return walk(mod.node(t, kid, 0)).find((e) => e.props.id === `card:${kid.id}`); };
  const on = cardOf(kid.address);
  assert.equal(on.props.bg, t.raised);
  assert.equal(on.props.border_color, t.working);
  assert.equal(on.props.rounded, 6);
  assert.equal(walk(on).find((e) => e.props.id === `row:${kid.id}`).props.bg, undefined, "no fill on the header row");
  const off = cardOf("other");
  assert.equal(off.props.bg, undefined);
  assert.equal(off.props.border_color, t.border);
  // the root is uncarded: its row keeps the fill
  const root = render(top([]), true);
  assert.equal(byId(root, "agent:t5")[0].props.bg, t.selected);
  assert.equal(byId(root, "card:").length, 0);
});

test("an agent directly under the uncarded root keeps its status glyph; one inside a card has none", () => {
  const kid = sess("k", "kid", { hcTerminal: "t9" }, [run("b", "builder")]);
  const root = render(top([kid, run("r", "reviewer")]));
  const rows = walk(root).filter((e) => /^row:.*\/a\d+$/.test(String(e.props.id ?? "")));
  const inCard = walk(byId(root, "card:").find((e) => e.props.id.endsWith("/s0"))).find((e) => /^row:.*\/a0$/.test(String(e.props.id ?? "")));
  const under = rows.find((e) => e !== inCard);
  assert.ok(under && inCard, "both rows found");
  assert.equal(under.kids.length, inCard.kids.length + 1, "the root-level agent has one more cell, the glyph");
});

test("status lines get an icon and a dot-separated age", () => {
  assert.deepEqual(statusLine({ text: "wait: 1 pr watch 29s", blocked: false }), { icon: "⏳", text: "1 pr watch · 29s" });
  assert.deepEqual(statusLine({ text: "bg: build 3m", blocked: false }), { icon: "⚙", text: "build · 3m" });
  assert.deepEqual(statusLine({ text: "wait: x", blocked: true }), { icon: "", text: "wait: x" });
  assert.deepEqual(statusLine({ text: "", blocked: false }), { icon: "", text: "" });
});
