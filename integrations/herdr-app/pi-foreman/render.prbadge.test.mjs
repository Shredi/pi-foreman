import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { PR_LEGEND } = await import("./model.js");
const { sess, treeOf } = await import("./fixtures.mjs");

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const isBadge = (e) => e.props?.font_semibold && e.props.text_size === 10;
const badgeOf = (el) => walk(el).find(isBadge);
const mod = () => { const m = Object.create(Mod.prototype); m.changed = {}; m.feed = []; m.folded = new Set(); return m; };
const lineOf = (key, e, form) => mod().prChip(stubs.theme(), { ...e.sample, number: 12, title: "Change twelve" }, "https://example.test/x/pull/12", key, { title: "Change twelve", form });
const SAMPLE = PR_LEGEND.filter((e) => e.key !== "pr-conflict");
const INK = { "pr-draft": "#ansi5", "pr-not-reviewed": "#ansi4", "pr-running": "#ansi3", "pr-required-wait": "#ansi3", "pr-ready": "#ansi2", "pr-ci-passing": "#ansi2", "pr-failed": "#blocked", "pr-failed-running": "#blocked", "pr-no-checks": "#dim" };

for (const [key, form, label] of [["k", "session", "PR #12"], ["op-x/y", "list", "#12"]]) {
  test(`${form} line: every state has its own badge (colour, tint or outline, check mark, pulse), label ${label}`, () => {
    for (const e of SAMPLE) {
      const chip = lineOf(key, e, form);
      const b = badgeOf(chip.props.trigger);
      assert.ok(b, `${e.key}: a badge`);
      const ink = b.props.text_color;
      if (INK[e.key]) assert.equal(ink, INK[e.key], `${e.key}: colour`);
      assert.equal(b.props.border_color, e.key === "pr-required-wait" ? ink : `${ink}55`, `${e.key}: border`);
      assert.equal(b.props.bg, e.key === "pr-required-wait" ? undefined : `${ink}2e`, `${e.key}: tint or outline`);
      assert.equal(b.props.flex_none, true, `${e.key}: never shrinks`);
      assert.deepEqual((b.kids ?? []).filter((k) => typeof k === "string"), e.key.startsWith("pr-ready") ? ["✓ ", label] : [label], `${e.key}: label`);
      assert.equal(b.props.loop !== undefined, ["pr-running", "pr-draft-running", "pr-failed-running"].includes(e.key), `${e.key}: pulse`);
      assert.equal(walk(chip.props.trigger).some((x) => x.props?.size === 6), false, `${e.key}: no dot`);
    }
  });
}

test("the title is in the normal brightness and truncates; the badge has no fixed-width cell", () => {
  const chip = lineOf("k", SAMPLE[0], "session");
  const [cell, title] = chip.props.trigger.kids;
  const t = walk(title).find((e) => e.kids?.includes("Change twelve"));
  assert.equal(t.props.text_color, "#foreground");
  assert.equal(t.props.truncate, true);
  assert.equal(t.props.flex_1, true);
  assert.equal(cell.props.w, undefined);
  assert.equal(chip.props.trigger.props.on_click !== undefined, true, "the click stays");
});

test("the conflict mark sits beside the badge", () => {
  const e = PR_LEGEND.find((x) => x.key === "pr-conflict");
  const [cell, slot] = lineOf("k", e, "session").props.trigger.kids;
  assert.ok(badgeOf(cell));
  assert.ok(walk(slot).some((x) => x.kids?.includes("!")));
});

test("plan and wait lines under a session are dimmer than the PR title", () => {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const m = mod();
  const waits = [{ id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [16] }];
  const root = sess("f", "foreman-x", { pid: 7, hcTerminal: "t5", dots: [{ n: 16, state: "ok", label: "#16", src: "pr", name: "ci" }], waits });
  m.radar = new Map([["local", { ok: true, tree: [treeOf(root)], openPrs: [], tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  const out = m.render({});
  const wait = walk(out).find((e) => (e.kids ?? []).some((k) => typeof k === "string" && k.includes("pr watch")));
  assert.ok(wait, "the wait line is drawn");
  assert.equal(wait.props.text_color, "#dim");
});
