// foreman_show (index.ts): the tool result text is the same with or without a served URL; the URL goes to a UI notify line only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageLinks } from "../pagelinks.ts";
import { r11Rig } from "./_r11rig.ts";

const URL_ = "http://127.0.0.1:47317/SeCrEt123/note-1.html";

async function show(t: Parameters<typeof r11Rig>[0], fake: typeof pageLinks.url, hasUI = true) {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const notes: string[] = [];
  const ui = { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
  const rig = await r11Rig(t, {}, { ctx: { ui, hasUI }, piExtra: { registerTool: (d: { name: string }) => void tools.set(d.name, d as never) } });
  const was = pageLinks.url;
  pageLinks.url = fake;
  t.after(() => void (pageLinks.url = was));
  const r = await tools.get("foreman_show")!.execute("id", { title: "Same", markdown: "# hi\n" }, undefined, undefined, rig.ctx);
  // the temp folder differs between rigs: normalise the show folder
  return { text: r.content[0].text.replace(/\S*[\\/]show[\\/][^\s\\/]+[\\/]/g, "<show>/"), notes: notes.filter((n) => n.startsWith("Note page:")) };
}

test("foreman_show: the tool result is byte-identical with a served URL available; the notify line carries the URL", async (t) => {
  const calls: { path: string; kind: string }[] = [];
  const served = await show(t, async (p, kind) => (calls.push({ path: p, kind }), URL_));
  const plain = await show(t, async () => null);
  assert.equal(served.text, plain.text);
  assert.ok(!served.text.includes("SeCrEt123") && !served.text.includes("127.0.0.1"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "dir");
  assert.match(calls[0].path, /pages[\\/]note-1\.html$/);
  assert.ok(served.notes.includes(`Note page: ${URL_}`), JSON.stringify(served.notes));
  assert.ok(!plain.notes.some((n) => n.startsWith("Note page:")));
});

test("foreman_show: no UI, no served-URL lookup and no notify line", async (t) => {
  let asked = 0;
  const r = await show(t, async () => (asked++, URL_), false);
  assert.equal(asked, 0);
  assert.deepEqual(r.notes.filter((n) => n.startsWith("Note page:")), []);
});
