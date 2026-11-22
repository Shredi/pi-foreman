// Ledger session-own-changes 2: diffWithFacts with a `drop` predicate removes the dropped files' diff blocks before the scan (no facts, no name
// budget spent); without it the output is the plain git diff, as before. Real temp repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffWithFacts, dropDiffBlocks, git } from "../diffscan.ts";
import { gitIn } from "./_submodules.ts";

function repo(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-drop-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, "init", "-q", "-b", "main");
  for (const f of ["a_session.py", "z_old.py"]) fs.writeFileSync(path.join(dir, f), "def run(x):\n    return x\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
  for (const f of ["a_session.py", "z_old.py"]) fs.writeFileSync(path.join(dir, f), "def run(x, y):\n    return x\n");
  return dir;
}

test("without drop the diff is the plain git diff; with drop a dropped file's block and facts are gone", async (t) => {
  const dir = repo(t);
  const plain = await git(dir, ["diff", "--no-color", "--no-ext-diff", "--unified=0", "-M", "HEAD", "--"]);
  const all = await diffWithFacts(dir, null);
  assert.equal(all.diff, plain);
  const cut = await diffWithFacts(dir, null, (f) => f === "z_old.py");
  assert.ok(cut.diff && cut.diff.includes("a_session.py") && !cut.diff.includes("z_old.py"));
  assert.ok(!cut.facts.some((f) => f.text.includes("z_old.py")));
});

test("an old file and a session file both change an exported run: the session file's signature fact is still reported", async (t) => {
  const dir = repo(t);
  const all = await diffWithFacts(dir, null);
  assert.ok(all.facts.every((f) => !f.text.includes("a_session.py")), "today the later file shadows the earlier one");
  const cut = await diffWithFacts(dir, null, (f) => f === "z_old.py");
  assert.ok(cut.facts.some((f) => f.kind === "signature" && f.text.includes("a_session.py")), JSON.stringify(cut.facts));
  const none = await diffWithFacts(dir, null, () => true);
  assert.deepEqual([none.diff?.trim(), none.facts], ["", []]);
});

test("dropDiffBlocks takes the rename target as the file of a block", () => {
  const d = "diff --git a/old.py b/new.py\nsimilarity index 90%\nrename from old.py\nrename to new.py\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/k.py b/k.py\n@@ -1 +1 @@\n-c\n+d\n";
  assert.equal(dropDiffBlocks(d, (f) => f === "new.py"), "diff --git a/k.py b/k.py\n@@ -1 +1 @@\n-c\n+d\n");
  assert.equal(dropDiffBlocks(d, () => false), d);
});
