// Ledger session-own-changes 1, 4: the dirty-base session entry (planstate.ts): round trip, the restore rules, malformed data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCeremonyState, buildDirtyBase, CEREMONY_ENTRY, DIRTY_BASE_ENTRY, restoreDirtyBase } from "../planstate.ts";

const MAP = { "/r/a": { repo: "/r/A", head: "a".repeat(40), paths: { "x.ts": "5891b5b522d5df08", "y/": "deleted" } }, "/r/b": { repo: "/r/b", head: null, paths: null } };
const dirty = (data: unknown) => ({ type: "custom", customType: DIRTY_BASE_ENTRY, data });
const ceremony = { type: "custom", customType: CEREMONY_ENTRY, data: { v: 1 } };

test("an entry round-trips, and the newest one wins", () => {
  const e = JSON.parse(JSON.stringify(dirty(buildDirtyBase(MAP)))) as unknown;
  assert.deepEqual(restoreDirtyBase([e], "reload"), { map: MAP, fresh: false });
  assert.deepEqual(restoreDirtyBase([dirty(buildDirtyBase({})), ceremony, e], "resume").map, MAP);
  assert.deepEqual(restoreDirtyBase([e, ceremony, dirty(buildDirtyBase({}))], "fork"), { map: {}, fresh: false });
});

test("no dirty-base entry: a ceremony entry means a legacy session, neither means new on startup and new, legacy on any other start", () => {
  for (const r of ["startup", "new", "reload", "resume", "fork"]) assert.deepEqual(restoreDirtyBase([ceremony], r), { map: null, fresh: false }, r);
  assert.deepEqual(restoreDirtyBase([], "startup"), { map: {}, fresh: true });
  assert.deepEqual(restoreDirtyBase([], "new"), { map: {}, fresh: true });
  for (const r of ["reload", "resume", "fork"]) assert.deepEqual(restoreDirtyBase([], r), { map: null, fresh: false }, r);
  assert.deepEqual(restoreDirtyBase([{ type: "message" }, null], "startup"), { map: {}, fresh: true });
});

test("a malformed entry reads as a legacy session", () => {
  for (const bad of [null, "x", { v: 2, map: {} }, { v: 1 }, { v: 1, map: [] }, { v: 1, map: { k: { repo: 1, head: null, paths: null } } }, { v: 1, map: { k: { repo: "r", head: 5, paths: null } } }, { v: 1, map: { k: { repo: "r", head: null, paths: { a: 1 } } } }, { v: 1, map: { k: { repo: "r", head: null } } }]) {
    assert.deepEqual(restoreDirtyBase([dirty(bad)], "startup"), { map: null, fresh: false }, JSON.stringify(bad));
  }
});

test("the ceremony-state entry does not carry the map", () => {
  const data = buildCeremonyState({ plan: null, lineages: [], planPhase: false });
  assert.ok(!JSON.stringify(data).includes("dirty"));
  assert.ok(!("dirtyBase" in data) && !("map" in data));
});
