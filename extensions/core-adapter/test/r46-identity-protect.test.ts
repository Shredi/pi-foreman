// R46 item 1: `<handoff>/live.json` binds a handoff to a Pi session, so it is write-protected like `parent` and `child`.
// (The permission overlay that enforced it is gone; the baseline file still lists it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the baseline lists live.json next to parent and child in both blocks", () => {
  const text = fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8");
  for (const f of ["parent", "child", "live.json"]) assert.equal(text.split(`handoffs/*/${f}"`).length - 1, 2, f);
});
