import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const radar = (note) => {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [sess("fm", "foreman", { hcTerminal: "t1", show: { dir: "/s/fm", note } })] }));
  return { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: [], tried: Date.now() };
};
const mod = (note) => {
  const m = Object.create(Mod.prototype);
  m.radar = new Map([["local", radar(note)]]);
  return m;
};
const withBlock = { id: "root", type: "column", children: [{ id: "tabs", type: "stack", children: [{ id: "pp", type: "block", content: { mod: "pi-foreman-plan" } }] }] };
const withoutBlock = { id: "root", type: "column", children: [{ id: "x", type: "block", content: { mod: "files" } }] };

test("a note that rises in a layout without the plan block posts one notice per version; the first sight does not", () => {
  world.notices = []; world.shared = { layout: "main" }; world.layout = withoutBlock;
  const m = mod(1);
  m.noteNotice();
  assert.equal(world.notices.length, 0, "first sight only records the version");
  m.noteNotice();
  assert.equal(world.notices.length, 0, "an unchanged version stays quiet");
  m.radar = new Map([["local", radar(2)]]);
  m.noteNotice(); m.noteNotice();
  assert.equal(world.notices.length, 1);
  assert.match(world.notices[0].body, /"mod": "pi-foreman-plan"/);
  assert.match(world.notices[0].body, /docs\/herdr\.md#notes/);
  m.radar = new Map([["local", radar(3)]]);
  m.noteNotice();
  assert.equal(world.notices.length, 2, "the next version is announced again");
});

test("no notice when the layout has the block or cannot be read", () => {
  world.notices = []; world.shared = { layout: "foreman" }; world.layout = withBlock;
  let m = mod(1);
  m.noteNotice();
  m.radar = new Map([["local", radar(2)]]);
  m.noteNotice();
  assert.equal(world.notices.length, 0);
  world.shared = { layout: "other" }; world.layout = null;
  m = mod(1);
  m.noteNotice();
  m.radar = new Map([["local", radar(2)]]);
  m.noteNotice();
  assert.equal(world.notices.length, 0);
});
