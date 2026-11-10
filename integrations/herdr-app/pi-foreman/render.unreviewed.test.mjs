import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { UNREVIEWED } = await import("./model.js");
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
const chipTexts = (el) => walk(el).filter((e) => e.kind === "HoverCard").flatMap((c) => texts(c.props.trigger));

const waits = (unreviewed) => [{ id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [16], ...(unreviewed ? { unreviewed: [{ n: 16, repo: "", host: "" }] } : {}) }];
const tree = (w) => treeOf(sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", dots: [dot(16, "ok")], waits: w }));

test("the chip of a PR whose head the watch reports unreviewed shows the token", () => {
  const shown = chipTexts(render(tree(waits(true))));
  assert.ok(shown.includes("⎇ #16"));
  assert.ok(shown.includes(UNREVIEWED));
});

test("the chip of a followed-only PR, or one cleared by a PASS, has no token", () => {
  assert.ok(!chipTexts(render(tree(waits(false)))).includes(UNREVIEWED));
  assert.ok(!chipTexts(render(tree([]))).includes(UNREVIEWED));
});
