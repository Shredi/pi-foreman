// D211: npm_ and sk- masking follow the real token shapes; escaped quotes in a secret-named value are honoured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskKeys } from "../judgereads.ts";

test("npm_ variables and properties stay visible; a 36-char npm token is masked", () => {
  const plain = "process.env.npm_lifecycle_event\n$npm_package_version $npm_config_registry\n";
  assert.equal(maskKeys(plain), plain);
  const token = `npm_${"aB3".repeat(12)}`;
  assert.equal(token.length, 40);
  const masked = maskKeys(`registry = ${token}\n`);
  assert.ok(!masked.includes(token) && masked.includes("[redacted]"), masked);
});

test("sk- CSS classes stay visible; sk- key shapes stay masked", () => {
  const css = ".sk-spinner-circle { }\n<div class=\"sk-fading-circle sk-spinner-circle-large\">\n";
  assert.equal(maskKeys(css), css);
  for (const key of ["sk-abcdefghijklmnopqrstuvwx", "sk-proj-abcdefghijklmnopqrstuvwxyz0123", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123"]) {
    const masked = maskKeys(`k = ${key}\n`);
    assert.ok(!masked.includes("abcdefghij") && masked.includes("[redacted]"), masked);
  }
});

test("an escaped quote inside a secret-named value is masked whole", () => {
  const masked = maskKeys('password = "ab\\"cd"\n');
  assert.ok(!masked.includes("cd") && masked.includes("[redacted]"), masked);
  const single = maskKeys("secret = 'ab\\'cd'\n");
  assert.ok(!single.includes("cd"), single);
});
