import { test } from "node:test";
import assert from "node:assert/strict";
import { editorBackupCommand, editorBackupDelete } from "../effects.ts";

test("path, wrapper and unlink forms of an editor-backup delete are caught", () => {
  for (const cmd of ["/bin/rm foo.ts~", "command rm -f a.orig", "sudo rm x.swp", "sudo -n rm .#x", "unlink a.bak", "/usr/bin/unlink src/a.bak", "cd d && command rm -- b.bak", "env rm a~"]) {
    assert.ok(editorBackupCommand(cmd), cmd);
  }
});

test("the same forms on ordinary files stay unflagged", () => {
  for (const cmd of ["/bin/rm build/out.js", "command rm a.txt", "sudo rm -rf build", "unlink link.txt", "command ls a.bak", "echo rm a.bak"]) {
    assert.ok(!editorBackupCommand(cmd), cmd);
  }
  assert.ok(editorBackupDelete(["rm", "a~"]));
});
