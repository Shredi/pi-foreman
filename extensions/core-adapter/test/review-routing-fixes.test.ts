// Revision round of review-routing: a [pre-pr] launch's items may name closed ledger items but not ids the ledger lacks (item 3), and a directory outside git
// keys a high-stakes run to the session's own key, not to itself (item 4, one budget instead of one per directory).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { launchItemsOf } from "../verdict.ts";
import { build, hsPass, launch, setup } from "./_hsrig.ts";

const LEDGER = "- [ ] 1. open\n- [x] 2. closed\n- [ ] V. check\n";

test("item 3: a [pre-pr] items field may name a closed item and V, an id the ledger lacks is unknown; another occasion still takes open items only", () => {
  assert.deepEqual(launchItemsOf(LEDGER, [2], { occasion: "pre-pr" }), { items: [2] });
  assert.deepEqual(launchItemsOf(LEDGER, [1, 2, "V"], { occasion: "pre-pr" }), { items: [1, 2, "V"] });
  const bad = launchItemsOf(LEDGER, [42], { occasion: "pre-pr" });
  assert.deepEqual("unknown" in bad ? bad.unknown : null, [42]);
  const closed = launchItemsOf(LEDGER, [2], { occasion: "item" });
  assert.ok("unknown" in closed, "an item review still takes open items only");
});

test("item 4: two directories outside git share the session's high-stakes budget", async (t) => {
  const s = await setup(t);
  s.w.state.answer = "allow once";
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pf-nogit-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const d1 = path.join(outside, "one");
  const d2 = path.join(outside, "two");
  fs.mkdirSync(d1);
  fs.mkdirSync(d2);
  await build(s.a, { size: { files: ["src/a/x.ts"] }, risk: ["design"] });
  await hsPass(s.a, d1);
  const second = await launch(s.a, "reviewer", "[high-stakes] review the whole change", { cwd: d2 });
  assert.match(second.blocked ?? "", /\[high_stakes_done\]/, "the second directory has no budget of its own");
});
