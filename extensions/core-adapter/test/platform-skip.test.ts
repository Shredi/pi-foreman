import { test } from "node:test";
import assert from "node:assert/strict";
import { posix, posixOnly, skipUnlessPosix } from "./_platform.ts";

test("skipUnlessPosix gives a skip reason on win32", () => {
  const reason = skipUnlessPosix("win32");
  assert.equal(typeof reason, "string");
  assert.notEqual(reason, "");
});

test("skipUnlessPosix does not skip on linux or darwin", () => {
  assert.equal(skipUnlessPosix("linux"), false);
  assert.equal(skipUnlessPosix("darwin"), false);
});

test("posix and posixOnly follow the running platform", () => {
  assert.equal(posix, process.platform !== "win32");
  assert.equal(posixOnly, skipUnlessPosix(process.platform));
});
