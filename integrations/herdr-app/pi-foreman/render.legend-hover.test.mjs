import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { PR_LEGEND, prStateText } = await import("./model.js");
const { world } = stubs;

function view() {
  world.props = { sample: true };
  world.execCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.init({}, { timer: { every() {} }, spawn() {}, notify() {} });
  return mod;
}
const els = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => els(k, out));
  if (el.contentEl) els(el.contentEl, out);
  if (el.props?.trigger) els(el.props.trigger, out);
  return out;
};
const hasText = (el, text) => (el.kids ?? []).includes(text);
const card = (root) => els(root).find((e) => e.kind === "HoverCard" && e.cardId === "legend-card");
const textOf = (el) => els(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

test("the title bar has the legend's ? directly before Plan", () => {
  const root = view().render({});
  const bar = els(root).find((e) => e.kids?.some((k) => k?.props?.id === "plan-open"));
  assert.ok(bar, "title bar");
  const ids = bar.kids.map((k) => k?.props?.id ?? (k?.kind === "HoverCard" ? k.props.trigger?.props?.id : undefined));
  assert.equal(ids.indexOf("legend-open") + 1, ids.indexOf("plan-open"), "legend-open sits right before plan-open");
  assert.ok(els(card(root).props.trigger).some((e) => hasText(e, "?")));
});

test("the legend content is built only once the pointer rests on the ?", () => {
  const mod = view();
  let root = mod.render({});
  assert.equal(card(root).contentEl.kids.length, 0, "empty before hover");
  assert.ok(!textOf(card(root)).includes("Pull request badges"));
  card(root).props.trigger.props.on_hover(true, { notify() {} });
  root = mod.render({});
  const text = textOf(card(root).contentEl);
  assert.ok(text.includes("Pull request badges"));
  for (const e of PR_LEGEND) assert.ok(text.includes(e.words), `${e.key}: ${e.words}`);
  const rows = card(root).contentEl.kids.filter((k) => k?.kind === "h_flex");
  assert.equal(rows.length, PR_LEGEND.length, "one row per entry");
  rows.forEach((row, i) => {
    const ready = PR_LEGEND[i].key.startsWith("pr-ready");
    assert.ok(els(row).some((e) => e.props?.font_semibold && e.props.text_size === 10 && hasText(e, "PR #12") && (!ready || hasText(e, "✓ "))), `row ${PR_LEGEND[i].key} has its badge`);
    assert.ok(hasText(els(row).find((e) => hasText(e, PR_LEGEND[i].words)) ?? {}, PR_LEGEND[i].words));
    if (PR_LEGEND[i].key !== "pr-conflict") assert.equal(prStateText(PR_LEGEND[i].sample), PR_LEGEND[i].words);
  });
});
