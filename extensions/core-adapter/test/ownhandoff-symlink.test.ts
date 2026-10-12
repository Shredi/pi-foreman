// R3b point 8b: the parent/child guard sees through symlinks (a link to the handoff dir or to its parent file).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { effectCtx } from "../effects.ts";
import { readBaseline } from "../permoverlay.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ownho-sym-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const wt = path.join(base, "repo.worktrees", "round");
const handoff = path.join(base, "agent", "pi-foreman", "handoffs", "20260101-000000-demo");
for (const d of [path.join(wt, ".git"), path.join(wt, ".workflow", "scratch"), handoff]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, ".workflow", "scratch", "plan.md"), "plan\n");
fs.writeFileSync(path.join(handoff, "brief.md"), "brief\n");
fs.writeFileSync(path.join(handoff, "parent"), "p-1\n");
fs.writeFileSync(path.join(handoff, "child"), "fm-demo-abc123\n");
const posix = process.platform !== "win32";
const allow = (cmd: string): string | null => deterministicAllow(rules, cmd, { effects: effectCtx(wt), ownDirs: [handoff] });

test("a link back to the handoff dir cannot reach parent or child", { skip: !posix }, () => {
  fs.symlinkSync(handoff, path.join(handoff, "self"));
  assert.notEqual(allow(`cp ${wt}/.workflow/scratch/plan.md ${handoff}/self/parent`), "own-handoff");
  assert.notEqual(allow(`mkdir -p ${handoff}/self/child`), "own-handoff");
  assert.notEqual(allow(`cp ${wt}/.workflow/scratch/plan.md ${handoff}/self/self/child`), "own-handoff");
});

test("a link whose final component points at parent is refused", { skip: !posix }, () => {
  fs.symlinkSync(path.join(handoff, "parent"), path.join(handoff, "alias"));
  fs.symlinkSync(path.join(handoff, "parent"), path.join(wt, ".workflow", "scratch", "plink"));
  assert.notEqual(allow(`cp ${wt}/.workflow/scratch/plan.md ${handoff}/alias`), "own-handoff");
  assert.notEqual(allow(`cp ${wt}/.workflow/scratch/plan.md ${wt}/.workflow/scratch/plink`), "own-handoff");
});

test("normal R3 lines still pass beside the links", { skip: !posix }, () => {
  assert.equal(allow(`mkdir -p ${wt}/.workflow/scratch/top && cp ${handoff}/brief.md ${wt}/.workflow/scratch/top/brief.md`), "own-handoff");
  assert.equal(allow(`cp ${wt}/.workflow/scratch/plan.md ${handoff}/plan.md && cat ${handoff}/parent; ls ${handoff}`), "own-handoff");
});
