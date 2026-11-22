// Ledger session-own-changes 1, 5, 6: the per-checkout baseline (dirtybase.ts): what it records, what counts as unchanged, the hash spec
// (the same vectors as tests/test_foreman_close.py), the 2000 path cap and the key rule. Real temp repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkoutKey, dirDigest, hashPath, MAX_BASE_PATHS, parseStatusZ, takeBaseline, unchangedSince } from "../dirtybase.ts";
import { gitIn } from "./_submodules.ts";

function repo(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dirtybase-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, "init", "-q", "-b", "main");
  for (const [f, text] of [["README", "r\n"], ["gone.txt", "g\n"], ["old.txt", "o\n"]]) fs.writeFileSync(path.join(dir, f), text);
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("hash spec vectors: a file, a missing path, a link target and a directory digest", async (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "u.txt"), "hello\n");
  assert.equal(await hashPath(dir, "u.txt"), "5891b5b522d5df08");
  assert.equal(await hashPath(dir, "nothing.txt"), "deleted");
  assert.equal(dirDigest("abc123", "?? x\0"), "dir:5befc4edba8ace35");
  assert.equal(dirDigest("", ""), "dir:01ba4719c80b6fe9");
  if (process.platform !== "win32") {
    fs.symlinkSync("target.txt", path.join(dir, "l"));
    assert.equal(await hashPath(dir, "l"), "link:199b3badd968634e");
  }
});

test("takeBaseline records modified, untracked, deleted, both sides of a staged rename, a link and a .workflow/ file", async (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "README"), "changed\n");
  fs.writeFileSync(path.join(dir, "u.txt"), "hello\n");
  fs.rmSync(path.join(dir, "gone.txt"));
  gitIn(dir, "mv", "old.txt", "new.txt");
  fs.mkdirSync(path.join(dir, ".workflow"));
  fs.writeFileSync(path.join(dir, ".workflow", "LEDGER-x.md"), "l\n");
  if (process.platform !== "win32") fs.symlinkSync("target.txt", path.join(dir, "l"));
  const b = await takeBaseline(dir);
  assert.ok(b);
  assert.equal(b.repo, dir);
  assert.equal(b.key, checkoutKey(dir));
  assert.match(String(b.head), /^[0-9a-f]{40}$/);
  const p = b.paths as Record<string, string>;
  const want = ["README", "u.txt", "gone.txt", "old.txt", "new.txt", ".workflow/LEDGER-x.md", ...(process.platform === "win32" ? [] : ["l"])];
  assert.deepEqual(Object.keys(p).sort(), want.sort());
  assert.equal(p["u.txt"], "5891b5b522d5df08");
  assert.equal(p["gone.txt"], "deleted");
  assert.equal(p["old.txt"], "deleted");
  if (process.platform !== "win32") assert.equal(p.l, "link:199b3badd968634e");
});

test("takeBaseline on an unborn branch has no head; outside a repository it is null", async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dirtybase-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await takeBaseline(dir), null);
  gitIn(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a"), "a\n");
  const b = await takeBaseline(dir);
  assert.equal(b?.head, null);
  assert.deepEqual(Object.keys(b?.paths ?? {}), ["a"]);
});

test("unchangedSince: all after no change; an edited file, a re-created deleted file and a new content drop out", async (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "README"), "changed\n");
  fs.writeFileSync(path.join(dir, "u.txt"), "hello\n");
  fs.rmSync(path.join(dir, "gone.txt"));
  const b = await takeBaseline(dir);
  const paths = b?.paths as Record<string, string>;
  assert.deepEqual([...(await unchangedSince(dir, paths))].sort(), ["README", "gone.txt", "u.txt"]);
  fs.writeFileSync(path.join(dir, "u.txt"), "hello again\n");
  fs.writeFileSync(path.join(dir, "gone.txt"), "back\n");
  assert.deepEqual([...(await unchangedSince(dir, paths))], ["README"]);
});

test("a nested repository is recorded by a dir: digest of its HEAD and status", async (t) => {
  const dir = repo(t);
  const inner = path.join(dir, "inner");
  fs.mkdirSync(inner);
  gitIn(inner, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(inner, "f"), "f\n");
  gitIn(inner, "add", "f");
  gitIn(inner, "commit", "-q", "-m", "i");
  const b = await takeBaseline(dir);
  const key = Object.keys(b?.paths ?? {}).find((k) => k.startsWith("inner"));
  assert.ok(key, JSON.stringify(b?.paths));
  const h = (b?.paths ?? {})[key] as string;
  assert.match(h, /^dir:[0-9a-f]{16}$/);
  fs.writeFileSync(path.join(inner, "g"), "g\n");
  assert.notEqual(await hashPath(dir, key), h, "a change inside it changes the digest");
});

test("more than 2000 changed paths: no path map", async (t) => {
  const dir = repo(t);
  fs.mkdirSync(path.join(dir, "many"));
  for (let i = 0; i <= MAX_BASE_PATHS; i++) fs.writeFileSync(path.join(dir, "many", `f${i}`), "x");
  const b = await takeBaseline(dir);
  assert.ok(b);
  assert.equal(b.paths, null);
  assert.equal(b.repo, dir);
});

test("parseStatusZ lists both sides of a rename or copy once", () => {
  assert.deepEqual(parseStatusZ("R  new.txt\0old.txt\0?? u.txt\0 M a\0C  c2\0c1\0 M a\0"), ["new.txt", "old.txt", "u.txt", "a", "c2", "c1"]);
  assert.deepEqual(parseStatusZ(""), []);
});

test("checkoutKey: separators to /, lowercased on win32 and darwin only", () => {
  assert.equal(checkoutKey("/Tmp/Nope/Repo", "win32"), "/tmp/nope/repo");
  assert.equal(checkoutKey("/Tmp/Nope/Repo", "darwin"), "/tmp/nope/repo");
  assert.equal(checkoutKey("/Tmp/Nope/Repo", "linux"), "/Tmp/Nope/Repo");
  assert.equal(checkoutKey("C:\\Tmp\\Nope", "win32"), "c:/tmp/nope");
});

test("a dir: entry never counts as unchanged, even re-edited inside without a status change", async (t) => {
  const dir = repo(t);
  const inner = path.join(dir, "inner");
  fs.mkdirSync(inner);
  gitIn(inner, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(inner, "f"), "f\n");
  gitIn(inner, "add", "f");
  gitIn(inner, "commit", "-q", "-m", "i");
  fs.writeFileSync(path.join(inner, "g"), "g\n"); // untracked inside: status text "?? g"
  const b = await takeBaseline(dir);
  const paths = b?.paths as Record<string, string>;
  const key = Object.keys(paths).find((k) => k.startsWith("inner")) as string;
  assert.match(paths[key], /^dir:/);
  assert.equal(await hashPath(dir, key), paths[key], "same status text, same digest");
  fs.writeFileSync(path.join(inner, "g"), "edited again\n"); // same status text
  assert.equal(await hashPath(dir, key), paths[key]);
  assert.equal((await unchangedSince(dir, paths)).has(key), false);
});

test("an executable bit is part of a regular file's fingerprint (POSIX)", { skip: process.platform === "win32" }, async (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "u.sh"), "hello\n");
  fs.chmodSync(path.join(dir, "u.sh"), 0o644);
  const plain = await hashPath(dir, "u.sh");
  assert.equal(plain, "5891b5b522d5df08");
  fs.chmodSync(path.join(dir, "u.sh"), 0o755);
  assert.equal(await hashPath(dir, "u.sh"), "5891b5b522d5df08:x");
  assert.equal((await unchangedSince(dir, { "u.sh": plain })).size, 0);
});

test("an unreadable file is 'unreadable' and never unchanged; a missing path below a file is 'deleted'", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "u.txt"), "hello\n");
  assert.equal(await hashPath(dir, "README/below"), "deleted", "ENOTDIR");
  fs.chmodSync(path.join(dir, "u.txt"), 0o000);
  t.after(() => {
    try {
      fs.chmodSync(path.join(dir, "u.txt"), 0o644);
    } catch {
      // the checkout is already removed
    }
  });
  assert.equal(await hashPath(dir, "u.txt"), "unreadable");
  assert.equal((await unchangedSince(dir, { "u.txt": "unreadable" })).size, 0, "unreadable baseline and current");
  assert.equal((await unchangedSince(dir, { "u.txt": "5891b5b522d5df08" })).size, 0);
});
