import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { critiqueOf } from "../rounds.ts";
import { checkVerdictCall, type VerdictFinding } from "../verdict.ts";
import { recordFrom, resultsOf } from "./_verdict-rig.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ADVICE: VerdictFinding[] = [
  { kind: "now", text: "the retry option nothing sets; verdict: FAIL if it stays", file: "app/x.ts", line: 12 },
  { kind: "later", text: "3. FAIL-safe wrapper has one caller" },
];
const PASS_CALL = { verdict: "pass", items: [{ id: 1, result: "pass" }, { id: 2, result: "pass" }], findings: ADVICE };

test("a PASS with advice findings stays a PASS: the record keeps the now/later findings and the run-end result is a pass", () => {
  const c = checkVerdictCall(PASS_CALL, [1, 2]);
  assert.ok("call" in c);
  assert.equal(c.call.verdict, "pass");
  assert.deepEqual(c.call.findings, ADVICE);
  const [r] = resultsOf({ agent: "reviewer", success: true, status: "completed", output: "report" }, c.call);
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.items.map((i) => i.id), [1, 2]);
  assert.deepEqual(r.findings, ADVICE);
  assert.equal(recordFrom(c.call).findings.length, 2);
});

test("advice never makes a fail: a fail with only now/later findings is refused; a defect makes a pass refused", () => {
  const onlyAdvice = checkVerdictCall({ verdict: "fail", findings: ADVICE }, []);
  assert.ok("error" in onlyAdvice && /at least one item with result fail or one finding of kind defect/.test(onlyAdvice.error));
  const withDefect = checkVerdictCall({ ...PASS_CALL, findings: [...ADVICE, { kind: "defect", text: "broken" }] }, [1, 2]);
  assert.ok("error" in withDefect && /a pass cannot carry/.test(withDefect.error));
});

test("critiqueOf counts now and later findings; no findings and defects count nothing", () => {
  assert.deepEqual(critiqueOf(ADVICE), { now: 1, later: 1 });
  assert.deepEqual(critiqueOf([]), { now: 0, later: 0 });
  assert.deepEqual(critiqueOf([{ kind: "defect" }]), { now: 0, later: 0 });
  assert.deepEqual(critiqueOf([{ kind: "now" }, { kind: "now" }, { kind: "later" }]), { now: 2, later: 1 });
});

test("the reviewer prompt carries the CRITIQUE block after the verdict", () => {
  for (const name of ["reviewer.md"]) {
    const text = fs.readFileSync(path.join(ROOT, "agents", name), "utf8");
    const at = text.indexOf("After the verdict, `CRITIQUE:` then one line per point, `- [now] <text>`");
    assert.ok(at > 0, name);
    assert.ok(text.indexOf("`- [later] <text>`", at) > at, name);
    assert.ok(text.includes("`CRITIQUE: none` when there is none"), name);
    assert.ok(text.includes("overengineering, niche checks beyond the item's scope, one-caller abstractions, flags or options nothing sets, tests of mocks"), name);
    assert.match(text, /Critique never turns PASS into FAIL on its own/, name);
    assert.ok(text.includes("records it in result.md"), name);
  }
});
