// A paired key block hides its base64 runs whatever wraps each line; a short last line only when it has the same wrapper as the masked line above it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskKeys } from "../judgereads.ts";

const L1 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
const L2 = "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu";
const L3 = "NMoSfm76oqFvAp8Gy0iBmjk=";
const FRAGMENTS = ["MIIEvQIBAD", "MzEfYyjiWA", "NMoSfm76oq"];
const B = "-----BEGIN PRIVATE KEY-----";
const E = "-----END PRIVATE KEY-----";

const forms: Array<[string, string]> = [
  ["JS concatenation", `const k = "${B}\\n" +\n  "${L1}\\n" +\n  "${L2}\\n" +\n  "${L3}\\n" +\n  "${E}\\n";\n`],
  ["shell continuation", `KEY="${B}\\n\\\n${L1}\\n\\\n${L2}\\n\\\n${L3}\\n\\\n${E}"\n`],
  ["C comment", `/*\n * ${B}\n * ${L1}\n * ${L2}\n * ${L3}\n * ${E}\n */\n`],
  ["markdown quote", ["> " + B, "> " + L1, "> " + L2, "> " + L3, "> " + E].join("\n") + "\n"],
  ["SQL comment", ["-- " + B, "-- " + L1, "-- " + L2, "-- " + L3, "-- " + E].join("\n") + "\n"],
  ["YAML list", ["- " + B, "- " + L1, "- " + L2, "- " + L3, "- " + E].join("\n") + "\n"],
  ["cat -n", [B, L1, L2, L3, E].map((l, i) => `     ${i + 1}\t${l}`).join("\n") + "\n"],
];

for (const [name, text] of forms) {
  test(`key block wrapped as ${name}: no key fragment is shown`, () => {
    const out = maskKeys(text);
    for (const f of FRAGMENTS) assert.ok(!out.includes(f), `${name} shows ${f}: ${JSON.stringify(out)}`);
  });
}

test("the wrapper stays visible around the masked run", () => {
  const out = maskKeys(`x = "${B}\\n" +\n  "${L1}\\n" +\n  "${L3}\\n" +\n  "${E}\\n"\n`);
  assert.match(out, /"\[redacted\]\\n" \+\n/);
});

test("a short last line is masked when its wrapper equals the masked line above", () => {
  const out = maskKeys(`${B}\n  '${L1}',\n  '${L3}',\n${E}\n`);
  assert.ok(!out.includes("NMoSfm76oq"));
  assert.ok(out.includes("  '[redacted]',"));
});

test("a short line with a different wrapper than the line above stays visible", () => {
  const out = maskKeys(`${B}\n  '${L1}',\n  ${L3}\n${E}\n`);
  assert.ok(out.includes("NMoSfm76oq"));
});

test("a short line is not masked without a masked line directly above it", () => {
  const out = maskKeys(`${B}\nrm -rf ~\n${L3}\n${E}\n`);
  assert.ok(out.includes("NMoSfm76oq"));
  assert.ok(out.includes("rm -rf ~"));
});

test("a word or path right after a key line stays visible", () => {
  const out = maskKeys(`${B}\n${L1}\nreboot\n/usr/local/bin/aa/bb/cc/dd/ee/ff/gg/hh/payload\n${E}\n`);
  assert.ok(out.includes("reboot"));
  assert.ok(out.includes("payload"));
});
