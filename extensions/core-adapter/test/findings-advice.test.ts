// The findings `record` input: class `other` is a finding class, and the non-defect findings of a verdict record go as advice (findings.ts recordInput, verdict.ts adviceOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordInput } from "../findings.ts";
import { adviceOf, checkVerdictCall, FINDING_CLASSES } from "../verdict.ts";
import type { VerdictFinding } from "../verdict.ts";

const findings: VerdictFinding[] = [
  { kind: "defect", text: "bug", file: "a.ts", line: 3, class: "other" },
  { kind: "later", text: "rename", file: "b.ts", line: 9 },
  { kind: "now", text: "add a doc line" },
];

test("other is a finding class and a verdict call accepts it", () => {
  assert.ok((FINDING_CLASSES as readonly string[]).includes("other"));
  const r = checkVerdictCall({ verdict: "fail", findings: [{ kind: "defect", text: "x", file: "a.ts", class: "other" }] }, []);
  assert.ok("call" in r);
});

test("adviceOf keeps the now and later findings only", () => {
  assert.deepEqual(adviceOf(findings).map((f) => f.kind), ["later", "now"]);
});

test("recordInput gives defects as findings and the rest as advice, the file optional", () => {
  const input = JSON.parse(recordInput({ items: [], findings }));
  assert.deepEqual(input.findings, [{ file: "a.ts", line: 3, class: "other", note: "bug" }]);
  assert.deepEqual(input.advice, [{ kind: "later", note: "rename", file: "b.ts", line: 9 }, { kind: "now", note: "add a doc line" }]);
});
