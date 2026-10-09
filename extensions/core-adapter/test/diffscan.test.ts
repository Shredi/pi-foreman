import { test } from "node:test";
import assert from "node:assert/strict";
import { factsBlock, isTestPath, scanDiff } from "../diffscan.ts";

const diff = (file: string, removed: string[], added: string[], extra = ""): string =>
  `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((l) => `-${l}`).join("\n")}\n${added.map((l) => `+${l}`).join("\n")}\n`;
const texts = (d: string, ref?: (n: string) => string | null): string[] => scanDiff(d, ref ? (n) => ref(n) : undefined).map((f) => f.text);

test("go: exported signature change; lowercase only when a test file references it", () => {
  const d = diff("hub.go", ["func (h *Hub) Send(msg []byte) error {", "func (h *Hub) broadcast(msg []byte) {"], ["func (h *Hub) Send(seq uint64, msg []byte) error {", "func (h *Hub) broadcast(seq uint64, msg []byte) {"]);
  const none = texts(d);
  assert.equal(none.length, 1);
  assert.match(none[0], /signature changed \(exported\): hub\.go: func Send\(msg \[\]byte\) error -> \(seq uint64, msg \[\]byte\) error/);
  const withRef = texts(d, (n) => (n === "broadcast" ? "hub_test.go" : null));
  assert.equal(withRef.length, 2);
  assert.match(withRef[1], /not exported, but referenced by test file hub_test\.go.*broadcast/);
});

test("rust: pub fn change is reported, private fn without a test reference is not, an unchanged move is not", () => {
  const d = diff("src/lib.rs", ["pub fn run(a: u32) -> u32 {", "fn helper(a: u32) {"], ["pub fn run(a: u32, b: u32) -> u32 {", "fn helper(a: u32, b: u32) {"]);
  assert.equal(texts(d).length, 1);
  assert.match(texts(d)[0], /exported.*src\/lib\.rs: fn run/);
  assert.deepEqual(texts(diff("src/lib.rs", ["pub fn same(a: u32) {"], ["pub fn same(a: u32) {"])), []);
});

test("ts: export function / export const arrow; a removed export is reported as removed", () => {
  const d = diff("a.ts", ["export function load(a: string): void {", "export const make = (a: number) => a;", "export function gone(x: number) {"], ["export function load(a: string, b: number): void {", "export const make = (a: number, b: number) => a;"]);
  const t = texts(d);
  assert.equal(t.length, 3);
  assert.ok(t.some((x) => /signature changed.*function load/.test(x)));
  assert.ok(t.some((x) => /signature changed.*function make/.test(x)));
  assert.ok(t.some((x) => /declaration removed or renamed.*gone/.test(x)));
});

test("python: module-level def without underscore only", () => {
  const d = diff("pkg/mod.py", ["def public(a):", "def _private(a):", "    def nested(a):"], ["def public(a, b):", "def _private(a, b):", "    def nested(a, b):"]);
  const t = texts(d);
  assert.equal(t.length, 1);
  assert.match(t[0], /exported.*pkg\/mod\.py: def public/);
});

test("test files: modified, deleted, removed assertion (with its replacement), added skip markers", () => {
  const mod = diff("hub_test.go", ["\trequire.Equal(t, 200, received)"], ["\trequire.Greater(t, received, 0)"]);
  const t = texts(mod);
  assert.ok(t.includes("test file modified: hub_test.go"));
  assert.ok(t.some((x) => /assertion removed or changed in hub_test\.go: - require\.Equal\(t, 200, received\) replaced by \+ require\.Greater/.test(x)));
  const del = "diff --git a/tests/test_a.py b/tests/test_a.py\ndeleted file mode 100644\n--- a/tests/test_a.py\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-assert x == 1\n";
  assert.ok(texts(del).includes("test file deleted: tests/test_a.py"));
  const skips = ["\tt.Skip(\"flaky\")", "#[ignore]", "it.skip('x', () => {})", "@pytest.mark.skip(reason='x')", "@unittest.skip('x')"];
  const s = texts(diff("x_test.go", [], skips)).filter((x) => x.startsWith("skip marker added"));
  assert.equal(s.length, 5);
});

test("a new test file and a non-test assertion are not facts; the block is bounded and empty without facts", () => {
  const added = "diff --git a/new_test.go b/new_test.go\nnew file mode 100644\n--- /dev/null\n+++ b/new_test.go\n@@ -0,0 +1,1 @@\n+func TestX(t *testing.T) {}\n";
  assert.deepEqual(texts(added), []);
  assert.deepEqual(texts(diff("main.go", ["assert.True(x)"], [])), []);
  assert.equal(factsBlock([]), "");
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: "skip" as const, text: `skip marker added in f${i}_test.go: t.Skip()` }));
  const block = factsBlock(many, "abcdef0123456789");
  assert.match(block, /^\n## Facts to rule on/);
  assert.match(block, /\(\+10 more not shown\)/);
  assert.ok(isTestPath("src/a.test.ts") && isTestPath("tests/x.rs") && !isTestPath("src/contest.go"));
});
