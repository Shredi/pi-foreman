// Of two exclusive optional fields, an empty one ("" or []) counts as the one not given; both empty is refused as before
// (foreman_show html/markdown, foreman_ledger text/texts, item+text/entries, note/defer item/items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { absent, planLedgerCall } from "../ledgercall.ts";
import { r11Rig } from "./_r11rig.ts";

const gate = { last: null, revised: false };
const plan = (params: Record<string, unknown>) => planLedgerCall(params, { child: false, gate });
const refused = (params: Record<string, unknown>): string => {
  const r = plan(params);
  assert.ok("error" in r, JSON.stringify(params));
  return r.error;
};

test("absent: undefined, null, an empty text and an empty list are not given; everything else is", () => {
  for (const v of [undefined, null, "", []]) assert.equal(absent(v), true, JSON.stringify(v));
  for (const v of [" ", "x", [""], ["a"], 0, false, {}]) assert.equal(absent(v), false, JSON.stringify(v));
});

test("foreman_ledger add: an empty text or an empty texts list gives way to the other; both empty is refused", () => {
  assert.deepEqual(plan({ action: "add", text: "", texts: ["a", "b"] }), { calls: [["add", "a"], ["add", "b"]], items: "", attested: false });
  assert.deepEqual(plan({ action: "add", text: "x", texts: [] }), { calls: [["add", "x"]], items: "", attested: false });
  assert.deepEqual(plan({ action: "add", text: "x", texts: "" }), { calls: [["add", "x"]], items: "", attested: false });
  assert.match(refused({ action: "add", text: "", texts: [] }), /add needs text/);
  assert.match(refused({ action: "add", text: "x", texts: ["a"] }), /not both/);
  assert.match(refused({ action: "add", texts: [] }), /add needs text/);
});

test("foreman_ledger upsert: an empty item/text or an empty entries list gives way to the other; both empty is refused", () => {
  const two = { calls: [], items: "2", attested: false, upserts: [{ item: "2", text: "x" }] };
  assert.deepEqual(plan({ action: "upsert", item: "", text: "", entries: [{ item: 2, text: "x" }] }), two);
  assert.deepEqual(plan({ action: "upsert", text: "", entries: [{ item: 2, text: "x" }] }), two);
  assert.deepEqual(plan({ action: "upsert", item: 2, text: "y", entries: [] }), { calls: [], items: "2", attested: false, upsert: { item: "2", text: "y" } });
  assert.deepEqual(plan({ action: "upsert", item: "", text: "y" }), { calls: [], items: "", attested: false, upsert: { item: null, text: "y" } });
  assert.match(refused({ action: "upsert", text: "", entries: [] }), /upsert needs text/);
  assert.match(refused({ action: "upsert", text: "y", entries: [{ text: "x" }] }), /not both/);
  assert.match(refused({ action: "upsert", item: 1, entries: [{ text: "x" }] }), /not both/);
});

test("foreman_ledger note and defer: an empty item or an empty items list counts as not given", () => {
  assert.deepEqual(plan({ action: "note", item: "", items: [3], text: "n" }), { calls: [["note", "3", "n"]], items: "3", attested: false });
  assert.deepEqual(plan({ action: "defer", item: 2, items: [], text: "later" }), { calls: [["defer", "2", "later"]], items: "2", attested: false });
  assert.match(refused({ action: "note", item: "", items: [], text: "n" }), /needs exactly one item/);
  assert.match(refused({ action: "note", item: "", text: "n" }), /needs exactly one item/);
});

test("foreman_ledger mark: an empty items list is still no items", () => {
  assert.match(refused({ action: "mark", items: [] }), /mark needs items/);
  assert.deepEqual(plan({ action: "mark", items: [2], text: "" }), { calls: [["mark", "2"]], items: "2", attested: false });
});

test("foreman_show: an empty markdown or html gives way to the other; both empty is refused", async (t) => {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  const rig = await r11Rig(t, {}, { piExtra: { registerTool: (d: { name: string }) => void tools.set(d.name, d as never) } });
  const call = (params: Record<string, unknown>) => tools.get("foreman_show")!.execute("id", params, undefined, undefined, rig.ctx);
  const onlyHtml = await call({ title: "A", markdown: "", html: "<p>hi</p>" });
  assert.ok(!onlyHtml.isError, onlyHtml.content[0].text);
  const onlyMarkdown = await call({ title: "B", markdown: "# hi", html: "" });
  assert.ok(!onlyMarkdown.isError, onlyMarkdown.content[0].text);
  for (const params of [{ title: "C", markdown: "", html: "" }, { title: "C", html: "" }, { title: "C", markdown: "" }, { title: "C", markdown: "a", html: "<p>b</p>" }]) {
    const r = await call(params);
    assert.ok(r.isError, JSON.stringify(params));
    assert.match(r.content[0].text, /exactly one of markdown or html/);
  }
});
