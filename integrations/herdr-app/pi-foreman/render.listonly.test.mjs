import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree, numberCellWidth } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const dot = (number, state) => ({ n: number, state, label: `#${number}`, src: "pr", url: `https://example.test/acme/app/pull/${number}` });
const AGENT = { address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } };

function view(roots, terminals = []) {
  world.agents = [AGENT];
  world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }, ...terminals];
  world.runCalls = [];
  const d = parseRadarDoc(JSON.stringify({ v: 1, openPrsAt: new Date().toISOString(), roots, openPrs: [] }));
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
const cards = (el) => walk(el).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");
const rowsOf = (root) => walk(root).filter((e) => /^(row:|agent:t5$)/.test(String(e.props?.id ?? "")));
const lineOf = (root, n) => cards(root).find((c) => texts(c.props.trigger).includes(`⎇ #${n}`));
const cx = () => { const c = { stopped: 0, notify() {}, spawn() {}, stop_propagation() { c.stopped++; } }; return c; };

// a child session with its own paneless terminal t9: its row opens that terminal
const child = (dots) => sess("s-p", "agent-a", { pid: 7, hcTerminal: "t5" }, [sess("k", "kid", { pid: 9, hcTerminal: "t9", dots })]);
const kidTerm = { address: "t9", state: "live", parent: "t5", app: "pi", foreground: { pid: 9 } };

test("a session with one PR and one with two draw lines below the row and no chip on the row", () => {
  for (const dots of [[dot(201, "ok")], [dot(201, "ok"), dot(202, "fail")]]) {
    const root = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots })]).render({});
    assert.equal(cards(root).length, dots.length, "one line per PR");
    assert.equal(rowsOf(root).filter((r) => (r.kids ?? []).some((k) => k.kind === "HoverCard")).length, 0, "no chip on the title row");
    assert.ok(!texts(root).some((s) => /\+\d|\d+ PRs?\b/.test(s)), "no +k and no summary text");
  }
});

test("a click on a session row's free area opens the session; the name, the fold slot and a PR line keep their own clicks", () => {
  const m = view([child([dot(201, "ok"), dot(202, "fail")])], [kidTerm]);
  const root = m.render({});
  const row = walk(root).find((e) => e.props?.id === "row:hc:t9");
  assert.ok(row, "the child session row");
  assert.equal(typeof row.props.on_click, "function", "the row is clickable");
  assert.equal(row.props.cursor_pointer, true);
  const c = cx();
  row.props.on_click({}, c);
  assert.deepEqual(world.runCalls.at(-1), ["terminal.peek", { terminal: "t9" }], "the row opens the session");
  assert.equal(c.stopped, 0, "the row does not stop the click");
  const name = walk(row).find((e) => e.props?.id === "name:hc:t9");
  const n = cx();
  name.props.on_click({}, n);
  assert.equal(n.stopped, 1, "the name's click does not bubble into the row's");
  const line = cx();
  lineOf(root, 202).props.trigger.props.on_click({}, line);
  assert.equal(line.stopped, 1, "a PR line stops its click");
  const f = cx();
  m.foldSlot(stubs.theme(), "x", true).props.on_click({}, f);
  assert.equal(f.stopped, 1, "the fold slot stops its click");
});

test("the number cell never wraps and widens with the widest number", () => {
  const six = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots: [dot(123456, "ok"), dot(7, "ok")] })]).render({});
  const cell = (n) => walk(lineOf(six, n).props.trigger).find((e) => (e.kids ?? []).includes(`⎇ #${n}`));
  for (const n of [123456, 7]) {
    assert.equal(cell(n).props.whitespace_nowrap, true, `#${n} nowrap`);
    assert.equal(cell(n).props.w, 66, `#${n}: the cell is as wide for the whole list`);
  }
  assert.equal(numberCellWidth([{ number: 1234 }]), 52);
  assert.equal(numberCellWidth([{ number: 12345 }, { number: 1 }]), 59);
  assert.equal(numberCellWidth([]), 52);
  const four = view([sess("s-a", "agent-a", { pid: 7, hcTerminal: "t5", dots: [dot(1234, "ok")] })]).render({});
  assert.equal(walk(lineOf(four, 1234).props.trigger).find((e) => (e.kids ?? []).includes("⎇ #1234")).props.w, 52);
});
