import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

// A PR of a session that has ended while its pane-less hc child terminal lives on with nothing under it: the ended child leaves the
// tree, so its PR must still be drawn (in Open PRs), never dropped.
const URL_ = "https://example.org/o/r/pull/7";
const feedPr = { repo: "o/r", number: 7, title: "Fix the thing", url: URL_, state: "open", checks: [], headRefName: "fix-thing", branch: "fix-thing" };
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};

function mount(kid) {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess("f", "foreman-x", { hcTerminal: "t5" }, [sess("k", "kid", kid, [])])], openPrs: [feedPr], openPrsAt: new Date().toISOString() }));
  world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }, { address: "t9", state: "live", parent: "t5", foreground: { pid: 8 } }];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.radar = new Map([["local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() }]]);
  return m;
}

const ended = { repo: "o/r", branch: "fix-thing", hcTerminal: "t9", state: "closed", sym: "done", dots: [{ n: 7, state: "ok", label: "#7", src: "pr" }] };

const chipTexts = (out) => walk(out).filter((e) => e.kind === "HoverCard").flatMap((c) => walk(c.props.trigger).flatMap((e) => e.kids ?? []));

test("control: the PR of a live child terminal is drawn", () => {
  const out = mount({ ...ended, state: "working", sym: "working" }).render({});
  assert.ok(chipTexts(out).includes("⎇ #7"));
});

test("the PR of a closed session whose child terminal has nothing live below is still drawn", () => {
  assert.ok(chipTexts(mount(ended).render({})).includes("⎇ #7"), "the PR has a chip somewhere");
});
