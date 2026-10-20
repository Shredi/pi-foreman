import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { npmCiReason } from "../../setup.mjs";

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-npmci-"));
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  return root;
}
const touch = (file, sec) => fs.utimesSync(file, sec, sec);

test("npmCiReason: missing node_modules, a lock newer than the install, and a fresh install", () => {
  const root = checkout();
  try {
    assert.equal(npmCiReason(root), "missing");
    fs.mkdirSync(path.join(root, "node_modules"));
    const installed = path.join(root, "node_modules", ".package-lock.json");
    fs.writeFileSync(installed, "{}");
    touch(path.join(root, "package-lock.json"), 2000);
    touch(installed, 1000);
    assert.equal(npmCiReason(root), "stale");
    touch(installed, 3000);
    assert.equal(npmCiReason(root), null);
    fs.rmSync(path.join(root, "package-lock.json"));
    assert.equal(npmCiReason(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
