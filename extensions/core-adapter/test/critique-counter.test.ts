import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CritiqueCounter } from "../rounds.ts";
import { diffLinesOf } from "../findings.ts";
import { sanitizeTrace } from "../trace.ts";

const REVIEW = "VERDICT: PASS\n1. PASS ok\nCRITIQUE:\n- [now] drop the unused flag\n- [now] inline the one-caller helper\n- [later] split the module\nMissing: none";

test("CritiqueCounter: raised counts now + later lines with the round's diff lines; the next builder launch applies the now lines once", () => {
  const c = new CritiqueCounter();
  assert.deepEqual(c.onReview(REVIEW, "reviewer", "run1", 42), { event: "critique", kind: "raised", role: "reviewer", runId: "run1", count: 3, lines: 42 });
  assert.deepEqual(c.onBuilder(), { event: "critique", kind: "applied", role: "builder", count: 2 });
  assert.equal(c.onBuilder(), null, "a second builder launch applies nothing");
});

test("CritiqueCounter: a later review replaces unsent now lines; CRITIQUE: none raises 0 and applies nothing", () => {
  const c = new CritiqueCounter();
  c.onReview(REVIEW, "reviewer", "run1");
  assert.deepEqual(c.onReview("VERDICT: PASS\nCRITIQUE: none", "reviewer", "run2"), { event: "critique", kind: "raised", role: "reviewer", runId: "run2", count: 0 });
  assert.equal(c.onBuilder(), null);
});

test("critique trace records keep every field through the trace allowlist", () => {
  const rec = new CritiqueCounter().onReview(REVIEW, "reviewer", "run1", 7);
  assert.deepEqual(sanitizeTrace(rec), rec);
});

test("diffLinesOf counts added and removed lines, not the file headers", () => {
  const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-old\n+new\n+-- not a header\ndiff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n+a\n";
  assert.equal(diffLinesOf(diff), 4);
  assert.equal(diffLinesOf(null), 0);
});

test("index wiring: critique raised at a counted review run end, applied at an accepted builder launch, lines from the review launch diff", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
  assert.match(src, /for \(const r of reviewResults\) if \(r\.counts\) \{\r?\n\s+s\.trace\?\.emit\(s\.critique\.onReview\(r\.text, r\.role, runId, reviewLaunch\?\.lines\)\);/);
  assert.match(src, /subagentAgents\(input\)\.includes\("builder"\)\) \{\r?\n\s+const applied = s\.critique\.onBuilder\(\);/);
  assert.match(src, /if \(rl && diffText !== null\) rl\.lines = diffLinesOf\(diffText\);/);
});
