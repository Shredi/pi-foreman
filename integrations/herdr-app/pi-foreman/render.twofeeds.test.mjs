import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

// Two machines (local and "m") list the same PR #5, spelled with another case of the repository (and of the URL) by the second one.
// A session on one of them watches the PR: its chip carries the title of the feed, and Open PRs does not list it again.
const feedOf = (repo, base) => [{ repo, number: 5, title: "Fix the thing", state: "open", headRefName: "fix-thing", mergeable: "MERGEABLE", ...(base ? { url: `${base}/${repo}/pull/5` } : {}), checks: [{ n: "build", state: "ok" }] }];
const radarOf = (roots, openPrs) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs, openPrsAt: new Date().toISOString() }));
  return { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() };
};
const watcher = (repo, hcTerminal, base) => sess("s", "watcher", {
  hcTerminal, state: "working", sym: "working", repo, ...(base ? { repoUrl: `${base}/${repo}` } : {}),
  dots: [{ n: 5, state: "ok", label: "#5", src: "pr", ...(base ? { url: `${base}/${repo}/pull/5` } : {}) }],
});

function mount({ onMachine, base }) {
  world.agents = [
    { address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } },
    { address: "m/t9", pane: "p9", space: 2, space_name: "box", status: "idle", program: { name: "pi" } },
  ];
  world.terminals = [];
  world.spaces = [{ id: 1, machine: null }, { id: 2, machine: "m" }];
  world.notices = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set();
  // the second machine spells the repository (and URL) in upper case
  const local = onMachine === "local" ? [watcher("o/r", "t5", base)] : [];
  const remote = onMachine === "m" ? [watcher("O/R", "t9", base)] : [];
  m.radar = new Map([["local", radarOf(local, feedOf("o/r", base))], ["m", radarOf(remote, feedOf("O/R", base))]]);
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
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard");
const chip5 = (root) => cards(root).filter((c) => texts(c.props.trigger).includes("PR #5"));
const openPrRows = (root) => walk(root).filter((e) => /^op-/.test(String(e.props?.id ?? "")) && e.props.id !== "op-head");
const ev = { bounds: { width: 40, height: 16 }, position: { x: 100, y: 200 }, local_position: { x: 5, y: 5 } };

for (const base of ["", "https://example.test"]) {
  for (const onMachine of ["m", "local"]) {
    test(`the session on ${onMachine === "m" ? "the second" : "the first"} machine: one chip with the feed title, no Open PRs row${base ? " (with URLs)" : ""}`, () => {
      const m = mount({ onMachine, base });
      const root = m.render({});
      assert.deepEqual(openPrRows(root).map((e) => e.props.id), [], "nothing under Open PRs");
      assert.equal(chip5(root).length, 1, "the PR is drawn once");
      chip5(root)[0].props.trigger.props.on_mouse_move(ev, { notify() {} });
      assert.ok(texts(chip5(m.render({}))[0].contentEl).includes("Fix the thing"), "the chip's card has the feed title");
      assert.equal(m.feed.length, 1, "the feeds are merged into one entry per PR");
    });
  }
}
