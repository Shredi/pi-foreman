import test from "node:test";
import assert from "node:assert/strict";
import { radarKey, fmtAge } from "./model.js";
import { sess } from "./fixtures.mjs";

const rec = (over = {}, extra = {}) => ({ ok: true, nodes: [{ ...sess("a", "a"), ...over }], openPrs: [], openPrsAt: "t", ...extra });

test("radarKey ignores an age that reads the same, and sees one whose label changed", () => {
  assert.equal(fmtAge(100), fmtAge(101), "premise: neighbouring seconds share a label");
  assert.equal(radarKey(rec({ blockedS: 100 })), radarKey(rec({ blockedS: 101 })));
  assert.notEqual(radarKey(rec({ blockedS: 100 })), radarKey(rec({ blockedS: 4000 })));
  assert.equal(radarKey(rec({ waits: [{ ageS: 100 }] })), radarKey(rec({ waits: [{ ageS: 101 }] })));
});

test("radarKey sees a changed state, PR list, PR time and the off state", () => {
  const k = radarKey(rec());
  assert.notEqual(radarKey(rec({ state: "working" })), k);
  assert.notEqual(radarKey(rec({}, { openPrs: [{ number: 1 }] })), k);
  assert.notEqual(radarKey(rec({}, { openPrsAt: "u" })), k);
  assert.equal(radarKey({ ok: false }), "off");
  assert.equal(radarKey(null), "off");
});
