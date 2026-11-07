import test from "node:test";
import assert from "node:assert/strict";
import { myers, diffHunks, MAX_LINES, MAX_EDITS } from "./model.js";

// Applies the edit script of a diff and checks it turns `a` into `b`.
function replay(a, b, r) {
  const out = [];
  let i = 0;
  for (let j = 0; j <= b.length;) {
    while (i < a.length && r.del.has(i)) i++;
    if (j === b.length) break;
    if (r.ins.has(j)) { out.push(b[j]); j++; continue; }
    assert.equal(a[i], b[j], `unchanged line ${j}`);
    out.push(b[j]); i++; j++;
  }
  while (i < a.length && r.del.has(i)) i++;
  assert.equal(i, a.length, "every old line is kept or deleted");
  assert.deepEqual(out, b);
}

// Edit distance by dynamic programming: the length of the shortest script.
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) for (let j = 0; j <= b.length; j++) {
    dp[i][j] = i === 0 ? j : j === 0 ? i : a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j], dp[i][j - 1]) + 1;
  }
  return dp[a.length][b.length];
}

test("identical, empty and one-sided inputs", () => {
  assert.deepEqual([...myers(["a"], ["a"]).ins], []);
  assert.deepEqual([...myers([], ["a", "b"]).ins].sort(), [0, 1]);
  assert.deepEqual([...myers(["a", "b"], []).del].sort(), [0, 1]);
  assert.equal(myers([], []).d, 0);
});

test("a changed line is one deletion and one insertion", () => {
  const r = myers(["a", "b", "c"], ["a", "x", "c"]);
  assert.deepEqual([[...r.del], [...r.ins], r.d], [[1], [1], 2]);
});

test("random inputs: the script reproduces the target and is a shortest one", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let n = 0; n < 300; n++) {
    const alpha = 1 + rnd(5);
    const a = Array.from({ length: rnd(14) }, () => String(rnd(alpha)));
    const b = Array.from({ length: rnd(14) }, () => String(rnd(alpha)));
    const r = myers(a, b);
    assert.equal(r.ok, true);
    replay(a, b, r);
    assert.equal(r.d, distance(a, b), `distance of ${a} / ${b}`);
    assert.equal(r.ins.size + r.del.size, r.d);
  }
});

test("more than 4000 lines on a side: no diff, reason large", () => {
  const big = Array.from({ length: MAX_LINES + 1 }, (_, i) => `l${i}`);
  assert.deepEqual(myers(big, ["x"]), { ok: false, reason: "large" });
  assert.deepEqual(myers(["x"], big), { ok: false, reason: "large" });
});

test("two fully different 4000-line inputs pass the size cap and stop at the edit cap", () => {
  const a = Array.from({ length: MAX_LINES }, (_, i) => `a${i}`);
  const b = Array.from({ length: MAX_LINES }, (_, i) => `b${i}`);
  assert.deepEqual(myers(a, b), { ok: false, reason: "many" });
});

test("4000 lines with a few edits diff fine; the edit cap is a distance of 1500", () => {
  const a = Array.from({ length: MAX_LINES - 1 }, (_, i) => `l${i}`);
  const b = [...a];
  b[10] = "changed"; b.splice(2000, 0, "added");
  const r = myers(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.d, 3);
  const x = Array.from({ length: 800 }, (_, i) => `a${i}`);
  const y = Array.from({ length: 700 }, (_, i) => `b${i}`);
  assert.equal(myers(x, y).d, 1500);
  assert.equal(myers(x, [...y, "extra"]).ok, false, "1501 edits");
  assert.equal(MAX_EDITS, 1500);
});

test("hunks: context lines, the heading above, nearby changes merge, distant ones split", () => {
  const base = ["# Doc", "## Phases", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "## Decisions", "- [ ] open", "tail"].join("\n");
  const cur = ["# Doc", "## Phases", "p1", "p2", "NEW", "p3", "p4", "p5", "p6", "p7", "p8", "## Decisions", "- [x] done", "tail"].join("\n");
  const h = diffHunks(cur, base, 1);
  assert.equal(h.length, 2);
  assert.equal(h[0].heading, "Phases");
  assert.deepEqual(h[0].rows, [{ k: " ", s: "p2" }, { k: "+", s: "NEW" }, { k: " ", s: "p3" }]);
  assert.equal(h[1].heading, "Decisions");
  assert.deepEqual(h[1].rows.map((r) => r.k + r.s), [" ## Decisions", "-- [ ] open", "+- [x] done", " tail"]);
  assert.equal(diffHunks(cur, base, 3).length, 2, "seven unchanged lines between the changes: one more than twice the context");
  assert.equal(diffHunks(cur, base, 4).length, 1, "the contexts meet: merged");
});

test("hunks: nothing to show is [], no base or a refused diff is null; the appendix is not diffed", () => {
  assert.deepEqual(diffHunks("a\nb", "a\nb"), []);
  assert.equal(diffHunks("a", undefined), null);
  const base = Array.from({ length: 800 }, (_, i) => `a${i}`).join("\n");
  const cur = Array.from({ length: 800 }, (_, i) => `b${i}`).join("\n");
  assert.equal(diffHunks(cur, base), null);
  assert.deepEqual(diffHunks("body\n## Ruling\nAPPROVED", "body\n## Ruling\nold"), []);
});
