import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allowedShellDirs, editModeBlock, editModeOf, scratchDirOf, scratchRoot } from "../editmode.ts";

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-edit-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch", "src", "notes"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  fs.mkdirSync(path.join(root, "outside"));
  return { root, ws, opts: { cwd: ws, home: root, platform: process.platform } };
}

test("edit mode: config values; missing = scratchpad, unknown = readonly; invalid scratch dir = default", () => {
  assert.equal(editModeOf(undefined), "scratchpad");
  assert.equal(editModeOf("bounded"), "bounded");
  assert.equal(editModeOf("free"), "readonly");
  for (const bad of ["/abs", "C:\\x", "..", "a/../b", ".", "", 3]) assert.equal(scratchDirOf(bad), ".workflow/scratch", String(bad));
  assert.equal(scratchDirOf("notes/drafts"), "notes/drafts");
});

test("edit mode: readonly allows .workflow only, scratchpad adds the scratch dir, bounded defers", (t) => {
  const { ws, opts } = workspace(t);
  const block = (tool: string, input: Record<string, unknown>, mode: "readonly" | "scratchpad" | "bounded", dir = "notes") => editModeBlock(tool, input, mode, dir, opts);
  assert.match(block("edit", { path: "src/a.ts" }, "readonly") ?? "", /edit on 'src\/a\.ts' refused: foreman edits are readonly: delegate to a builder/);
  assert.equal(block("write", { path: ".workflow/n.md" }, "readonly"), "");
  assert.ok(block("write", { path: "notes/n.md" }, "readonly"), "readonly ignores the scratch dir (D1)");
  assert.equal(block("write", { path: "notes/n.md" }, "scratchpad"), "");
  assert.equal(block("write", { path: ".workflow/n.md" }, "scratchpad"), "");
  assert.match(block("write", { path: "src/a.ts" }, "scratchpad") ?? "", /foreman edits are scratchpad: delegate to a builder \(scratch: notes;/);
  assert.ok(block("write", { path: "notes" }, "scratchpad"), "the scratch folder itself is not writable");
  assert.ok(block("foreman_move", { src: "src/a.ts", dst: "notes/a.ts" }, "scratchpad"), "moving a project file into scratch is a change");
  assert.equal(block("foreman_copy", { src: "src/a.ts", dst: "notes/a.ts" }, "scratchpad"), "");
  assert.equal(block("write", { path: "src/a.ts" }, "bounded"), null);
  assert.equal(block("read", { path: "src/a.ts" }, "readonly"), "");
  assert.deepEqual(allowedShellDirs("scratchpad", "notes", ws, process.platform), [".workflow", "notes"]);
  assert.deepEqual(allowedShellDirs("readonly", "notes", ws, process.platform), [".workflow"]);
  assert.deepEqual(allowedShellDirs("bounded", "notes", ws, process.platform), [".workflow"]);
});

test("edit mode: a scratch dir that resolves outside the workspace or to a project folder is not a way out", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need rights on Windows");
  const { root, ws, opts } = workspace(t);
  fs.symlinkSync(path.join(root, "outside"), path.join(ws, "escape"));
  fs.symlinkSync(path.join(ws, "src"), path.join(ws, "notes", "into-src"));
  assert.equal(scratchRoot(fs.realpathSync(ws), "escape", process.platform), null);
  assert.ok(editModeBlock("write", { path: "escape/n.md" }, "scratchpad", "escape", opts));
  assert.deepEqual(allowedShellDirs("scratchpad", "escape", ws, process.platform), [".workflow"]);
  assert.ok(editModeBlock("write", { path: "notes/into-src/a.ts" }, "scratchpad", "notes", opts), "a link inside scratch cannot carry a write out of it");
});
