// `cp <src> <existing dir>` counts as a write of `<dir>/<name>`, like `mv`: into a sanctioned root dir itself it is a write inside; the checks of the written
// name (outside the roots, a symlink) stay.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { classify, effectCtx } from "../effects.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-cpdir-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
const scratch = path.join(base, "scratch");
const outside = path.join(base, "outside");
for (const d of [repo, scratch, outside, path.join(repo, ".git")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(repo, "a"), "x\n");
const ctx = () => effectCtx(repo, [scratch]);

test("cp into the existing scratch root itself is a write inside, as mv; into a dir outside the roots it stays a write outside", { skip: posixOnly }, () => {
  for (const prog of ["cp", "mv"]) assert.equal(classify(`${prog} a ${scratch}`, ctx()), "write-in", prog);
  assert.equal(classify(`cp a ${outside}`, ctx()), "write-out");
  assert.equal(classify(`mv a ${outside}`, ctx()), "write-out");
  assert.equal(classify(`cp a ${path.join(repo, ".git")}`, ctx()), "write-out");
});

test("cp into the scratch root keeps the symlink check of the written name", { skip: posixOnly }, () => {
  fs.symlinkSync(path.join(outside, "t"), path.join(scratch, "a"));
  assert.equal(classify(`cp a ${scratch}`, ctx()), "write-out");
});
