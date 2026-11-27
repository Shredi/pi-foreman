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

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random real-shape keys never reach the output (fixed seed)", () => {
  const rnd = prng(1127);
  const b64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alnum = b64url.slice(0, 62);
  const gen = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
  for (let i = 0; i < 500; i++) {
    for (const key of [`sk-ant-api03-${gen(b64url, 95)}`, `sk-proj-${gen(b64url, 48 + (i % 20))}`, `npm_${gen(alnum, 36)}`]) {
      const masked = maskKeys(`token value ${key} end\n`);
      assert.ok(!masked.includes(key.slice(-12)) && !masked.includes(key.slice(0, 20)), `${key} -> ${masked}`);
    }
  }
});

test("a key with a dash early in its body is masked; css stays visible; backslash-ending single-quoted value is masked", () => {
  const key = "sk-proj-Ab-Cd3fGhIjKlMnOpQrStUvWxYz0123456789";
  assert.ok(!maskKeys(`k=${key}\n`).includes("KlMnOp"));
  const svc = "sk-svcacct-aB-1cdefghijklmnopqrstuvwxyz";
  assert.ok(!maskKeys(`k=${svc}\n`).includes("klmnop"));
  assert.ok(!maskKeys("k=sk-admin-Ab1cdefghijklmnopqrstuvwxyz\n").includes("klmnop"));
  const css = ".sk-spinner-circle { }\n";
  assert.equal(maskKeys(css), css);
  const pw = maskKeys("PASSWORD='p4ssw0rd\\'\n");
  assert.ok(!pw.includes("p4ssw0rd") && pw.includes("[redacted]"), pw);
});

test("sk- + 25 word chars + dash + rest is masked whole, no tail visible", () => {
  const masked = maskKeys(`k=sk-${"abcde".repeat(5)}-tailtailxy\n`);
  assert.ok(!masked.includes("tail") && masked.includes("[redacted]"), masked);
});

test("sk- runs mask in linear time (1 MiB)", () => {
  for (const unit of ["sk-", `sk-${"a".repeat(19)}-`]) {
    const input = unit.repeat(Math.ceil((1 << 20) / unit.length));
    const t0 = performance.now();
    maskKeys(input);
    const ms = performance.now() - t0;
    console.log(`sk- timing ${unit.length}-char unit: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 5000, `${ms} ms`);
  }
});

test("URL userinfo, bearer and private-key masks run in linear time (1 MiB of adversarial text)", () => {
  const begin = "-----BEGIN PRIVATE KEY-----";
  for (const unit of ["://a:", "Authorization: Bearer ", "Bearer a", `${begin}\n`, `${begin}\n\n  \n`, `${begin}AAAA\nAAAA\n`, "a:b@://"]) {
    const input = unit.repeat(Math.ceil((1 << 20) / unit.length));
    const t0 = performance.now();
    maskKeys(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, `${JSON.stringify(unit)}: ${ms} ms`);
  }
});
