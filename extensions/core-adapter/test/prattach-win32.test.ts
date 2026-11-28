// attachRefusal compares the recorded checkout with the one computed now by the platform's path rules (win32: case and separators).
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachRefusal } from "../prattach.ts";
import type { ReviewRecord } from "../reviews.ts";

const SHA = "a".repeat(64);
const rec = (cwd: string): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: "h1", cwd, kind: "code", occasion: "pre-pr", attach: [{ path: "ok.png", sha256: SHA }] });
const files = [{ path: "ok.png", sha256: SHA }];

test("attachRefusal on win32: a drive-letter case or separator difference is the same checkout", () => {
  assert.equal(attachRefusal("pr_attach", [rec("c:\\Users\\Runner\\repo")], "C:\\Users\\runner\\repo", "h1", files, "win32"), null);
  assert.equal(attachRefusal("pr_attach", [rec("C:/Users/runner/repo")], "C:\\Users\\runner\\repo", "h1", files, "win32"), null);
});

test("attachRefusal: another checkout is still refused, and posix stays case-sensitive", () => {
  assert.equal(attachRefusal("pr_attach", [rec("C:\\a\\repo2")], "C:\\a\\repo", "h1", files, "win32")?.reason, "attach_unreviewed");
  assert.equal(attachRefusal("pr_attach", [rec("/Tmp/r")], "/tmp/r", "h1", files, "linux")?.reason, "attach_unreviewed");
});
