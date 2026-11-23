// D165: the drift check of foreman_worktree_remove also covers the target worktree's own repository when it is another clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitDriftWatch } from "../gitdrift.ts";

const HOME = os.tmpdir();
const NO_UI = { mode: "print", hasUI: false };
function repo(t: { after(fn: () => void): void }, name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pf-target-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n");
  return dir;
}
const gate = (w: GitDriftWatch, state: string, target: string, own: string) => w.gateTargetRepo(state, target, own, HOME, "foreman_worktree_remove", NO_UI, () => undefined);

test("another clone: the first sight takes the baseline, a planted config change is caught and blocks without a UI, an approval takes the new baseline", async (t) => {
  const a = repo(t, "a");
  const b = repo(t, "b");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pf-target-state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const w = new GitDriftWatch();
  assert.equal(await gate(w, state, b, a), undefined, "first sight");
  fs.appendFileSync(path.join(b, ".git", "config"), "[core]\n\tfsmonitor = /tmp/PLANTED\n");
  const blocked = await gate(w, state, b, a);
  assert.ok(blocked && /core\.fsmonitor/.test(blocked.reason), blocked?.reason);
  const yes = { mode: "tui", hasUI: true, confirm: async () => true };
  assert.equal(await w.gateTargetRepo(state, b, a, HOME, "x", yes, () => undefined), undefined);
  assert.equal(await gate(w, state, b, a), undefined, "approved: the new state is the baseline");
});

test("the session's own repository is left to the normal gate", async (t) => {
  const a = repo(t, "a");
  fs.mkdirSync(path.join(a, "sub"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pf-target-state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const w = new GitDriftWatch();
  assert.equal(await gate(w, state, path.join(a, "sub"), a), undefined);
  fs.appendFileSync(path.join(a, ".git", "config"), "[core]\n\tfsmonitor = /tmp/PLANTED\n");
  assert.equal(await gate(w, state, path.join(a, "sub"), a), undefined);
});
