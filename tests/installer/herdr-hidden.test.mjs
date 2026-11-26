// The installer preload hides a real `herdr` on PATH, so a non-dry setup run in these tests never starts the developer's Herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHerdr } from "../../setup/herdr-pi.mjs";

test("under the installer preload no herdr is found on PATH", { skip: process.platform === "win32" }, () => {
  assert.equal(findHerdr(process.env), null);
});
