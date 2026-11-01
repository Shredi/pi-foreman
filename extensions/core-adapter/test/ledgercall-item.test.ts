// foreman_ledger note/defer take the single `item` as documented; `items` with exactly one entry stays valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLedgerCall } from "../ledgercall.ts";

const gate = { last: null, revised: false };
const plan = (params: Record<string, unknown>) => planLedgerCall(params, { child: false, gate });

for (const action of ["note", "defer"]) {
  test(`${action}: item alone`, () => {
    assert.deepEqual(plan({ action, item: 3, text: "why" }), { calls: [[action, "3", "why"]], items: "3", attested: false });
  });
  test(`${action}: items with one entry`, () => {
    assert.deepEqual(plan({ action, items: [3], text: "why" }), { calls: [[action, "3", "why"]], items: "3", attested: false });
  });
  test(`${action}: item and the same single entry`, () => {
    assert.deepEqual(plan({ action, item: "3", items: [3], text: "why" }), { calls: [[action, "3", "why"]], items: "3", attested: false });
  });
  test(`${action}: refused for a differing item, two items, neither, a bad item or no text`, () => {
    for (const p of [{ item: 4, items: [3] }, { items: [3, 4] }, {}, { item: "x" }, { item: 3, items: [3, 4] }, { item: 3, text: "" }]) {
      const r = plan({ action, text: "why", ...p });
      assert.ok("error" in r, JSON.stringify(p));
    }
    const r = plan({ action, items: [1, 2], text: "why" });
    assert.match("error" in r ? r.error : "", /exactly one item \(`item` or `items: \[n\]`\) and text/);
  });
}

test("defer: V is refused, also through item; note V stays valid", () => {
  const r = plan({ action: "defer", item: "V", text: "later" });
  assert.ok("error" in r && /V cannot be deferred/.test(r.error));
  assert.ok("calls" in plan({ action: "note", item: "V", text: "n" }));
});
