import assert from "node:assert/strict";
import { test } from "node:test";

import { childNpmNote } from "../childnpm.ts";

test("childNpmNote: npm ci without install names the launch flag", () => {
  const t = childNpmNote("npm ci", false);
  assert.match(t, /^npm ci needs approval for a child/);
  assert.match(t, /relaunch you with the launch flag `install: true`/);
});

test("childNpmNote: install: true keeps the approval text and drops the flag hint", () => {
  const t = childNpmNote("cd pkg && npm ci", true);
  assert.match(t, /^npm ci needs approval for a child/);
  assert.doesNotMatch(t, /install: true/);
});

test("childNpmNote: npm install and other commands", () => {
  assert.match(childNpmNote("npm install left-pad", false), /^npm install needs approval for a child/);
  assert.equal(childNpmNote("npm run build", false), "");
  assert.equal(childNpmNote("echo npm ci", false), "");
});
