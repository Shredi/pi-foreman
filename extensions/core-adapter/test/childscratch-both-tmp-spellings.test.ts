// Item 6: the child-scratch exclusion (childscratch.ts insideScratch) holds for both spellings of the temp dir. insideScratch reads
// the real file system, so this runs on the host: the scratch dir is listed in its os.tmpdir() and its realpath spelling (differ on
// macOS: /var vs /private/var; on win32 hosts: 8.3 vs long). A write inside is in either spelling; the temp dir, a sibling scratch
// dir and a `..` escape are outside.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { insideScratch } from "../childscratch.ts";

const raw = fs.mkdtempSync(path.join(os.tmpdir(), "pf-both-"));
const real = fs.realpathSync.native(raw);
const spell = (p: string): string => path.join(raw, path.relative(real, p));
const scratch = path.join(real, "pi-foreman-scratch", "run1");
const sibling = path.join(real, "pi-foreman-scratch", "run2");
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(sibling, { recursive: true });
const dirs = [...new Set([scratch, spell(scratch)])];

test("inside the scratch dir, either spelling of the temp dir", () => {
  for (const mk of [(p: string) => p, spell]) {
    assert.equal(insideScratch(mk(path.join(scratch, "new", "f.txt")), dirs), true);
    assert.equal(insideScratch(mk(scratch), dirs), false, "the dir itself");
  }
});

test("the temp dir, a sibling scratch dir and a `..` escape are outside, either spelling", () => {
  for (const mk of [(p: string) => p, spell]) {
    assert.equal(insideScratch(mk(path.join(real, "x.txt")), dirs), false);
    assert.equal(insideScratch(mk(path.join(sibling, "x.txt")), dirs), false);
    assert.equal(insideScratch(`${mk(scratch)}${path.sep}..${path.sep}run2${path.sep}x.txt`, dirs), false);
  }
});
