// The shared top-level fence scanner (pages.ts scanFence): the fold loop, the block renderer and the owner-section rules use it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldPlanSection, renderMarkdown, scanFence } from "../pages.ts";
import { ownerSection, ownerSectionIssues } from "../ownertext.ts";

test("scanFence: indent, ~~~ fences, backtick info strings and the closing line", () => {
  assert.deepEqual(scanFence(["  ```js", "  a", "  ```", "x"], 0), { indent: "  ", mark: "```", info: "js", close: 2, next: 3 });
  assert.equal(scanFence(["~~~", "a", "~~~"], 0)?.next, 3);
  assert.equal(scanFence(["```", "a", "~~~", "b"], 0)?.close, 4, "a different marker does not close");
  assert.equal(scanFence(["```a`b", "x"], 0), null, "a backtick in the info string of a backtick fence is no fence");
  assert.equal(scanFence(["~~~a`b", "x", "~~~"], 0)?.close, 2, "a tilde fence may have one");
  assert.equal(scanFence(["    ```", "x"], 0), null, "four spaces is code, not a fence");
});

test("a `##` inside a fence is no section for the fold loop; an indented fence is stripped", () => {
  const html = renderMarkdown("## A\n~~~\n## Not a heading\n~~~\n\n## B\n  ```\n  code\n  ```\n", { fold: () => true });
  assert.equal((html.match(/<details>/g) ?? []).length, 2);
  assert.match(html, /<pre><code>## Not a heading<\/code><\/pre>/);
  assert.match(html, /<pre><code>code<\/code><\/pre>/);
  assert.equal(foldPlanSection("A"), true);
});

test("the owner section ignores a `##` heading inside any fence kind", () => {
  const text = "# P\n\n## For the owner\nWe do it.\n~~~md\n## Not next\n~~~\n  ```\n## Nor this\n  ```\nMore.\n\n## Goal\nx\n";
  assert.deepEqual(ownerSection(text)?.lines.slice(-1), ["More."]);
  assert.deepEqual(ownerSectionIssues(text), []);
});
