// D225: a reviewer launch's `diffBase` names the diff base; it must be an ancestor of HEAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDiffBase } from "../diffscan.ts";
import { takeLaunchFlags } from "../sizing.ts";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function repo(): { dir: string; first: string; side: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffbase-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a"), "1\n");
  git(dir, "add", "a");
  git(dir, "commit", "-q", "-m", "one");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(dir, "b"), "s\n");
  git(dir, "add", "b");
  git(dir, "commit", "-q", "-m", "side");
  const side = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "a"), "2\n");
  git(dir, "commit", "-q", "-am", "two");
  return { dir, first, side };
}

test("an ancestor of HEAD resolves to its full sha", async () => {
  const r = repo();
  try {
    assert.deepEqual(await resolveDiffBase(r.dir, r.first.slice(0, 8)), { sha: r.first });
    assert.deepEqual(await resolveDiffBase(r.dir, "HEAD"), { sha: git(r.dir, "rev-parse", "HEAD") });
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a commit that is not an ancestor of HEAD, an unknown ref and a flag are refused with the reason", async () => {
  const r = repo();
  try {
    const side = await resolveDiffBase(r.dir, r.side);
    assert.ok("error" in side && /not an ancestor of HEAD/.test(side.error));
    const none = await resolveDiffBase(r.dir, "no-such-ref");
    assert.ok("error" in none && /not a commit/.test(none.error));
    assert.ok("error" in (await resolveDiffBase(r.dir, "--all")));
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("takeLaunchFlags hands the diffBase of a reviewer entry over and removes the field from the call", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "t", diffBase: "abc1234" };
  const f = takeLaunchFlags(input);
  assert.equal(f.diffBases.get(input), "abc1234");
  assert.equal("diffBase" in input, false);
});
