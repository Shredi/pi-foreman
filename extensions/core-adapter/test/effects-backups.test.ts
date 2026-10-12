import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classify, effectCtx, editorBackupCommand } from "../effects.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "pf-backups-"));
fs.mkdirSync(path.join(base, ".git"));
fs.mkdirSync(path.join(base, "build"));
const c = effectCtx(base);

test("rm of editor backups is unknown and flagged", () => {
  for (const cmd of ["rm foo.ts~", "rm -f *.orig", "rm .#x", "rm -f src/a.bak", "rm x.swp", "cd build && rm -f a.orig"]) {
    assert.equal(classify(cmd, c), "unknown", cmd);
    assert.ok(editorBackupCommand(cmd), cmd);
  }
});

test("a plain rm of build output is unchanged", () => {
  assert.equal(classify("rm build/out.js", c), "write-in");
  assert.ok(!editorBackupCommand("rm build/out.js"));
  assert.ok(!editorBackupCommand("ls foo~"));
  assert.ok(!editorBackupCommand(undefined));
});
