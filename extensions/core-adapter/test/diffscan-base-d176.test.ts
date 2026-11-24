// D176: the review base after a rebase, a detached clean checkout at the base, a rebased PR branch and a merge of the base.
// Files byte-identical to the base yield no fact; only the branch's own change does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { diffWithFacts, ReviewFacts } from "../diffscan.ts";
import { reviewBaseOf } from "../highstakes.ts";

const g = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
const SKIP = (n: string): string => `package x\nfunc ${n}(t *testing.T) { t.Skip() }\n`;
const commit = (cwd: string, file: string, text: string): string => {
  fs.writeFileSync(path.join(cwd, file), text);
  g(cwd, "add", file);
  g(cwd, "commit", "-q", "-m", file);
  return g(cwd, "rev-parse", "HEAD");
};
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-d176-"));
  g(dir, "init", "-q", "-b", "main");
  commit(dir, "a.txt", "a\n");
  return dir;
}
const track = (dir: string): void => {
  g(dir, "update-ref", "refs/remotes/origin/main", g(dir, "rev-parse", "main"));
  g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
};
const facts = (): ReviewFacts => {
  const rf = new ReviewFacts();
  rf.mergeBase = (d) => reviewBaseOf(d, { baseBranch: null });
  return rf;
};
const factText = async (dir: string, rf: ReviewFacts): Promise<string> => (await diffWithFacts(dir, await rf.baseFor(dir))).facts.map((f) => f.text).join("\n");

for (const resolvable of [true, false]) {
  test(`rebase onto a moved main (base branch ${resolvable ? "resolves" : "does not resolve"}): files of main are no fact`, async () => {
    const dir = repo();
    try {
      g(dir, "checkout", "-q", "-b", "x");
      commit(dir, "own_test.go", SKIP("Own"));
      const rf = facts();
      await rf.noteBuilders({ agent: "builder" }, dir); // recorded: the pre-rebase head
      g(dir, "checkout", "-q", "main");
      commit(dir, "mainonly_test.go", SKIP("MainOnly"));
      if (resolvable) track(dir);
      g(dir, "checkout", "-q", "x");
      g(dir, "rebase", "-q", "main");
      const base = await rf.baseFor(dir);
      assert.equal(base, resolvable ? g(dir, "rev-parse", "main") : null);
      assert.ok(!(await factText(dir, rf)).includes("mainonly_test.go"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const resolvable of [true, false]) {
  test(`measurement-only detached clean checkout at the base (base branch ${resolvable ? "resolves" : "does not resolve"}): no fact`, async () => {
    const dir = repo();
    try {
      g(dir, "checkout", "-q", "-b", "x");
      commit(dir, "own_test.go", SKIP("Own"));
      const rf = facts();
      await rf.noteBuilders({ agent: "builder" }, dir);
      g(dir, "checkout", "-q", "main");
      commit(dir, "mainonly_test.go", SKIP("MainOnly"));
      if (resolvable) track(dir);
      g(dir, "checkout", "-q", "--detach", "main");
      assert.equal(await factText(dir, rf), "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a PR branch rebased after main took the same file: the file is byte-identical to base and gives no fact", async () => {
  const dir = repo();
  try {
    g(dir, "checkout", "-q", "-b", "x");
    commit(dir, "shared_test.go", SKIP("Shared"));
    const rf = facts();
    await rf.noteBuilders({ agent: "builder" }, dir);
    commit(dir, "own_test.go", SKIP("Own"));
    g(dir, "checkout", "-q", "main");
    commit(dir, "shared_test.go", SKIP("Shared")); // landed on main by another branch
    track(dir);
    g(dir, "checkout", "-q", "x");
    g(dir, "rebase", "-q", "main");
    const text = await factText(dir, rf);
    assert.ok(text.includes("own_test.go"));
    assert.ok(!text.includes("shared_test.go"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("merge of the base into the branch: the recorded head is behind the merge-base, main's files give no fact", async () => {
  const dir = repo();
  try {
    g(dir, "checkout", "-q", "-b", "x");
    commit(dir, "own_test.go", SKIP("Own"));
    const rf = facts();
    await rf.noteBuilders({ agent: "builder" }, dir);
    commit(dir, "own2_test.go", SKIP("Own2"));
    g(dir, "checkout", "-q", "main");
    commit(dir, "mainonly_test.go", SKIP("MainOnly"));
    track(dir);
    g(dir, "checkout", "-q", "x");
    g(dir, "merge", "-q", "--no-ff", "--no-edit", "main");
    assert.equal(await rf.baseFor(dir), g(dir, "rev-parse", "main"));
    assert.ok(!(await factText(dir, rf)).includes("mainonly_test.go"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
