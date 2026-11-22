// Ledger session-own-changes 1, 5: the session's checkout memo (dirtybase.ts memoCheckout: a resolved directory is answered from the memo, a null is retried)
// and the stat-safe walk to the nearest directory of a write (nearestDirectory: a path removed mid-walk never throws). Real temp repos; the
// stat race is simulated by stubbing statSync for one path after the path was found by the existence check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fsd from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { checkoutKey, memoCheckout, nearestDirectory, type CheckoutMemo } from "../dirtybase.ts";
import { gitIn } from "./_submodules.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dirtybase-memo-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("memoCheckout: a repeated lookup of a directory is answered from the memo (the repository is gone, the answer stays)", async (t) => {
  const dir = tmp(t);
  gitIn(dir, "init", "-q", "-b", "main");
  const memo: CheckoutMemo = new Map();
  const first = await memoCheckout(memo, dir);
  assert.deepEqual(first, { top: dir, key: checkoutKey(dir) });
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  assert.deepEqual(await memoCheckout(memo, dir), first, "no second rev-parse: the removed repository is still answered from the memo");
  assert.equal(memo.size, 1);
});

test("memoCheckout: a null is not memoised; a directory that becomes a repository later resolves on the next lookup", async (t) => {
  const dir = tmp(t);
  const memo: CheckoutMemo = new Map();
  assert.equal(await memoCheckout(memo, dir), null);
  assert.equal(memo.size, 0, "no null stored");
  gitIn(dir, "init", "-q", "-b", "main");
  assert.equal((await memoCheckout(memo, dir))?.key, checkoutKey(dir), "the next lookup resolves the new repository");
  assert.equal(memo.size, 1);
});

test("memoCheckout: a failed lookup (git cannot run in a missing directory) is retried once the directory exists", async (t) => {
  const dir = tmp(t);
  const sub = path.join(dir, "later");
  const memo: CheckoutMemo = new Map();
  assert.equal(await memoCheckout(memo, sub), null);
  assert.equal(memo.size, 0);
  fs.mkdirSync(sub);
  gitIn(sub, "init", "-q", "-b", "main");
  assert.equal((await memoCheckout(memo, sub))?.top, sub);
});

test("nearestDirectory: an existing directory is its own nearest; a missing path resolves to its nearest existing parent", (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, "a"));
  assert.equal(nearestDirectory(path.join(dir, "a", "f.txt")), path.join(dir, "a"));
  assert.equal(nearestDirectory(path.join(dir, "a", "x", "y", "f.txt")), path.join(dir, "a"));
});

test("nearestDirectory: a path that vanishes between the existence check and the stat does not throw; the walk goes to the parent", (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, "gone", "sub"), { recursive: true });
  const real = fsd.statSync;
  const target = path.join(dir, "gone", "sub");
  // the race: the directory exists for the existence check, and its stat fails as if it had been removed in between
  t.mock.method(fsd, "statSync", (p: fsd.PathLike, ...rest: unknown[]) => {
    if (String(p) === target) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), { code: "ENOENT" });
    return (real as (...a: unknown[]) => fsd.Stats)(p, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  assert.equal(nearestDirectory(path.join(target, "f.txt")), path.join(dir, "gone"));
});

test("nearestDirectory: every stat failing (the whole chain vanished) still returns a value and never throws", (t) => {
  const dir = tmp(t);
  t.mock.method(fsd, "statSync", () => {
    throw Object.assign(new Error("ENOENT: stat"), { code: "ENOENT" });
  });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  assert.equal(typeof nearestDirectory(path.join(dir, "a", "b", "f.txt")), "string");
});
