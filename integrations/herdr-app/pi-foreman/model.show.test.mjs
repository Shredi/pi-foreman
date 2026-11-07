import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, slimRadar, showRows, parseShowMeta, joinPath } from "./model.js";

const doc = (roots) => parseRadarDoc(JSON.stringify({ v: 1, roots }));
const sess = (key, over = {}, children = []) => ({ key, kind: "session", name: key, state: "idle", children, ...over });

test("a session's show pointer is read with checked types", () => {
  const n = doc([sess("a", { show: { dir: "/s/a", plan: 3, note: 1, ruled: 2, extra: "x" } })]).nodes[0];
  assert.deepEqual(n.show, { dir: "/s/a", plan: 3, note: 1 });
  assert.deepEqual(doc([sess("a", { show: { dir: "/s/a" } })]).nodes[0].show, { dir: "/s/a" });
  assert.deepEqual(doc([sess("a", { show: { dir: "/s/a", plan: "3", note: 1.5 } })]).nodes[0].show, { dir: "/s/a" });
});

test("a show pointer without a usable dir is dropped, so is an over-long one", () => {
  for (const show of [null, "x", [], {}, { dir: "" }, { dir: 5 }, { dir: "/" + "d".repeat(1030), plan: 1 }]) {
    assert.equal("show" in doc([sess("a", { show })]).nodes[0], false, JSON.stringify(show)?.slice(0, 30));
  }
  assert.equal("show" in doc([sess("a")]).nodes[0], false);
});

test("slimRadar keeps sessions with their join keys and show pointer, drops runs, costs and waits", () => {
  const nodes = doc([sess("fm", { hcTerminal: "t1", pid: 7, parent: "", cost: 3, waits: [{ kind: "x", age_s: 4 }], show: { dir: "/s/fm", plan: 2 } }, [
    { key: "run:1", kind: "run", name: "builder", children: [] }, sess("c1", { parent: "fm" }),
  ])]).nodes;
  const slim = slimRadar(nodes);
  assert.equal(slim.length, 1);
  assert.deepEqual(Object.keys(slim[0]).sort(), ["children", "hcTerminal", "key", "kind", "machine", "name", "parent", "pid", "show", "state"]);
  assert.deepEqual(slim[0].children.map((c) => c.key), ["c1"]);
  assert.deepEqual(slim[0].show, { dir: "/s/fm", plan: 2 });
});

test("slimRadar is stable while only ages and costs move, and bad input answers []", () => {
  const a = () => doc([sess("fm", { waits: [{ kind: "w", note: "n", age_s: 1 }], own: { cost: 1 } })]).nodes;
  const b = () => doc([sess("fm", { waits: [{ kind: "w", note: "n", age_s: 99 }], own: { cost: 5 } })]).nodes;
  assert.equal(JSON.stringify(slimRadar(a())), JSON.stringify(slimRadar(b())));
  assert.deepEqual(slimRadar(undefined), []);
  assert.deepEqual(slimRadar([null, 3, { kind: "run" }]), []);
});

test("plan and note rows carry the version and the age from plan.json / note.json", () => {
  const now = Date.parse("2026-11-06T10:04:00Z");
  const meta = { plan: parseShowMeta('{"v":3,"at":"2026-11-06T10:00:00Z"}'), note: parseShowMeta('{"v":1,"at":"2026-11-06T10:03:00Z"}') };
  assert.deepEqual(showRows({ dir: "/s", plan: 3, note: 1 }, meta, now), [
    { kind: "plan", text: "📄 plan v3 · 4m" }, { kind: "note", text: "📝 note · 1m" },
  ]);
  assert.deepEqual(showRows({ dir: "/s", plan: 2 }, {}, now), [{ kind: "plan", text: "📄 plan v2" }]);
  assert.deepEqual(showRows({ dir: "/s", note: 1 }, undefined, now), [{ kind: "note", text: "📝 note" }]);
  assert.deepEqual(showRows({ dir: "/s" }, meta, now), []);
  assert.deepEqual(showRows(null, meta, now), []);
});

test("parseShowMeta and joinPath", () => {
  assert.deepEqual(parseShowMeta('{"v":2,"at":"nonsense"}'), { v: 2, at: null });
  assert.equal(parseShowMeta("nope"), null);
  assert.equal(parseShowMeta("[]"), null);
  assert.equal(joinPath("/a/b/", "plan.json"), "/a/b/plan.json");
  assert.equal(joinPath("C:\\a\\b", "plan.json"), "C:\\a\\b\\plan.json");
});
