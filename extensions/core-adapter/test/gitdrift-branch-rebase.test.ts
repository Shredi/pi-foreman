// r79 item 17: additions of branch.<name>.remote, .merge and .rebase for a new round branch are routine (no ask, baseline updated);
// every other key change, and a rebase value that is not a plain true/false/merges, still asks.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffGitSnapshots, takeGitSnapshot } from "../gitdrift.ts";

const HOME = os.tmpdir();

function diffAfter(t: { after(fn: () => void): void }, add: string): string[] {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-drift17-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  const cfg = path.join(dir, ".git", "config");
  const base = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://example.invalid/r.git\n";
  fs.writeFileSync(cfg, base);
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(cfg, base + add);
  return diffGitSnapshots(before, takeGitSnapshot(dir, HOME));
}

test("a new round branch's remote, merge and rebase keys are routine", (t) => {
  assert.deepEqual(diffAfter(t, '[branch "round/79-perms-rules"]\n\tremote = origin\n\tmerge = refs/heads/round/79-perms-rules\n\trebase = true\n'), []);
  assert.deepEqual(diffAfter(t, '[branch "round/79-x"]\n\tremote = origin\n\tmerge = refs/heads/main\n\trebase = merges\n'), []);
});

test("a rebase value that is not plain, or another key next to the pair, still asks", (t) => {
  assert.deepEqual(diffAfter(t, '[branch "X"]\n\tremote = origin\n\tmerge = refs/heads/X\n\trebase = !sh -c x\n'), ["git:config: added branch.X.rebase"]);
  assert.deepEqual(diffAfter(t, '[branch "X"]\n\tremote = origin\n\tmerge = refs/heads/X\n\trebase = true\n[core]\n\tfsmonitor = x\n'), ["git:config: added core.fsmonitor"]);
});
