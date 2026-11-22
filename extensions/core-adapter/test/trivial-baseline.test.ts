// Ledger session-own-changes 2, 4, 6: the finish diff check counts only paths that differ from the session baseline. Real temp repos, no index rig.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { takeBaseline, type DirtyBase } from "../dirtybase.ts";
import { checkTrivial } from "../trivial.ts";
import { gitIn } from "./_submodules.ts";

const BOUND = { files: 2, lines: 40, newFiles: 3 };

function repo(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-trivbase-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "calc.py"), "def add(a, b):\n    return a + b\n");
  fs.writeFileSync(path.join(dir, "src", "test_calc.py"), "from calc import add\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
  return dir;
}
const put = (dir: string, rel: string, text = "x\n"): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
async function based(dir: string): Promise<DirtyBase> {
  const b = await takeBaseline(dir);
  assert.ok(b);
  return { [b.key]: { repo: b.repo, head: b.head, paths: b.paths } };
}
const check = (dir: string, base?: DirtyBase | null) => checkTrivial([], dir, BOUND, "", base);

test("30 preexisting dirty files, untouched: trivial; without the baseline they count", async (t) => {
  const dir = repo(t);
  for (let i = 0; i < 30; i++) put(dir, `junk/f${i}.txt`);
  const base = await based(dir);
  assert.equal(await check(dir, base), null);
  const old = await check(dir, undefined);
  assert.equal(old?.reason, "files");
  assert.doesNotMatch(String(old?.detail), /no session baseline/);
});

test("a legacy session (null) or a checkout without an entry: the old verdict plus the note", async (t) => {
  const dir = repo(t);
  for (let i = 0; i < 30; i++) put(dir, `junk/f${i}.txt`);
  for (const base of [null, {}] as (DirtyBase | null)[]) {
    const v = await check(dir, base);
    assert.equal(v?.reason, "files");
    assert.match(String(v?.detail), new RegExp(`30 source files changed \\(no session baseline for ${path.basename(dir)}: changes made before the session were counted\\)`));
  }
  const b = await takeBaseline(dir);
  const noMap: DirtyBase = { [b!.key]: { repo: b!.repo, head: b!.head, paths: null } };
  assert.match(String((await check(dir, noMap))?.detail), /no session baseline for/);
});

test("an untouched preexisting export change is no signature verdict; edited further it is counted", async (t) => {
  const dir = repo(t);
  put(dir, "src/calc.py", "def add(a, b, c=0):\n    return a + b\n");
  const base = await based(dir);
  assert.equal(await check(dir, base), null);
  assert.equal((await check(dir, undefined))?.reason, "signature");
  put(dir, "src/calc.py", "def add(a, b, c=0):\n    return a + b + c\n");
  assert.equal((await check(dir, base))?.reason, "signature");
});

test("250 preexisting untracked files do not push two new untracked files out of the window", async (t) => {
  const dir = repo(t);
  for (let i = 0; i < 250; i++) put(dir, `pre/f${String(i).padStart(3, "0")}.txt`);
  const base = await based(dir);
  put(dir, "zz/new1.txt");
  put(dir, "zz/new2.txt");
  const v = await check(dir, base);
  assert.equal(v?.reason, "files");
  assert.match(String(v?.detail), /^2 source files changed/);
});

test("preexisting untracked files: one edited further is counted, both edited are two files, a new file is counted", async (t) => {
  const dir = repo(t);
  put(dir, "src/n1.txt");
  put(dir, "src/n2.txt");
  const base = await based(dir);
  assert.equal(await check(dir, base), null);
  put(dir, "src/n1.txt", "changed\n");
  assert.equal(await check(dir, base), null, "one file is still trivial");
  put(dir, "src/n2.txt", "changed\n");
  assert.equal((await check(dir, base))?.reason, "files");
  put(dir, "src/n2.txt");
  put(dir, "src/n3.txt");
  assert.equal((await check(dir, base))?.reason, "files", "an edited and a new file");
});
