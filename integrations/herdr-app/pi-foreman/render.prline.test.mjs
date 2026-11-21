import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

// A PR line is the badge, the conflict mark only when the PR conflicts, then the title: no width cell, no blank slot.
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.props?.trigger) walk(el.props.trigger, out);
  return out;
};
const mod = () => { const m = Object.create(Mod.prototype); m.changed = {}; m.feed = []; m.folded = new Set(); return m; };
const pr = (number, over = {}) => ({ number, title: `Change ${number}`, state: "open", mergeable: "MERGEABLE", mergeState: "clean", checks: [{ n: "ci", state: "ok" }], ...over });
const lineOf = (p, form) => mod().prChip(stubs.theme(), p, "https://example.test/x/pull/1", "k", { title: p.title, form }).props.trigger;
const hasText = (el, s) => walk(el).some((e) => (e.kids ?? []).includes(s));

for (const [form, label] of [["session", "PR #12"], ["list", "#12"]]) {
  test(`${form} line: badge, then the title right after, with no fixed-width cell or blank slot`, () => {
    const line = lineOf(pr(12), form);
    assert.equal(line.kids.length, 2, "badge and title only");
    const [cell, title] = line.kids;
    assert.equal(cell.props.w, undefined, "no fixed width on the badge cell");
    assert.equal(cell.props.flex_none, true);
    assert.ok(hasText(cell, label), "the badge label");
    assert.equal(title.props.flex_1, true);
    assert.equal(title.props.truncate, true);
    assert.equal(title.props.min_w, 0);
    assert.ok(hasText(title, "Change 12"));
    assert.ok(!walk(line).some((e) => e.props?.w === 11), "no 11px slot");
  });

  test(`${form} line: a conflicting PR shows the mark between badge and title`, () => {
    const line = lineOf(pr(12, { mergeable: "CONFLICTING", mergeState: "dirty" }), form);
    assert.equal(line.kids.length, 3);
    const [cell, mark, title] = line.kids;
    assert.ok(hasText(cell, label));
    assert.ok(hasText(mark, "!"), "the conflict mark");
    assert.equal(mark.props.w, undefined);
    assert.ok(hasText(title, "Change 12"));
  });
}
