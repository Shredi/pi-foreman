import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CritiqueCounter } from "../rounds.ts";
import { diffLinesOf } from "../findings.ts";
import { sanitizeTrace } from "../trace.ts";

// the findings of a pass record: two now, one later
const REVIEW = [{ kind: "now", text: "drop the unused flag" }, { kind: "now", text: "inline the one-caller helper" }, { kind: "later", text: "split the module" }];

test("CritiqueCounter: raised counts now + later findings with the round's diff lines; the next builder launch applies the now findings once", () => {
  const c = new CritiqueCounter();
  assert.deepEqual(c.onReview(REVIEW, "reviewer", "run1", 42), { event: "critique", kind: "raised", role: "reviewer", runId: "run1", count: 3, lines: 42 });
  assert.deepEqual(c.onBuilder(), { event: "critique", kind: "applied", role: "builder", count: 2 });
  assert.equal(c.onBuilder(), null, "a second builder launch applies nothing");
});

test("CritiqueCounter: a later review replaces unsent now findings; no advice findings raise 0 and apply nothing", () => {
  const c = new CritiqueCounter();
  c.onReview(REVIEW, "reviewer", "run1");
  assert.deepEqual(c.onReview([], "reviewer", "run2"), { event: "critique", kind: "raised", role: "reviewer", runId: "run2", count: 0 });
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
  assert.match(src, /for \(const r of reviewResults\) if \(r\.counts\) \{\r?\n\s+s\.trace\?\.emit\(s\.critique\.onReview\(r\.findings, r\.role, runId, reviewLaunch\?\.lines\)\);/);
  assert.match(src, /subagentAgents\(input\)\.includes\("builder"\)\) \{\r?\n\s+const applied = s\.critique\.onBuilder\(\);/);
  assert.match(src, /if \(rl && diffText !== null\) rl\.lines = diffLinesOf\(diffText\);/);
});
