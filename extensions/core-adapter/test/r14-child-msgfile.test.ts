// R14 P1 item 2: the message-file operand of `git commit` / `git tag` (`-F f`, `--file f`, `--file=f`) is a read: the overlay's write
// protection (`{cwd}/.pi/*`) leaves it to git_guard's child allowlist (tests/test_git_guard_child_commit_f.py). Other commands' `-F`/`--file`
// words, a write of the same path elsewhere on the line, and attached or combined short forms stay protected. Each case runs through the
// overlay (checkToolCall) as a child in its worktree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-msgfile-")));
after(() => rmTestTmp(w));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [path.join(ws, ".pi", "scratch"), path.join(ws, ".workflow", "scratch"), ag]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ws, ".pi", "scratch", "m.txt"), "subject\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const child: MatchCtx = { cwd: ws, home, platform: process.platform, role: "child", roundRoots: [ws] };
const sh = (command: string): string => checkToolCall(rules, "bash", { command }, child)?.kind ?? "pass";

test("child_git_commit_F_pi_scratch_left_to_git_guard", () => {
  for (const cmd of [
    `git commit -F .pi/scratch/m.txt`,
    `git commit --file .pi/scratch/m.txt`,
    `git commit --file=.pi/scratch/m.txt`,
    `git commit -s -F .pi/scratch/m.txt`,
    `git tag -a v1 -F .pi/scratch/m.txt`,
    `git commit -F .workflow/scratch/m.txt`,
  ]) assert.equal(sh(cmd), "pass", `${cmd}: ${checkToolCall(rules, "bash", { command: cmd }, child)?.reason}`);
});

test("child_msgfile_other_positions_still_protected", () => {
  // the same overlay verdict as before R14: a write, another subcommand, a value of -m, a pathspec, an attached or combined short form
  for (const cmd of [
    `touch .pi/scratch/m.txt`,
    `git commit -F .pi/scratch/m.txt; touch .pi/scratch/m.txt`,
    `git commit -F .pi/scratch/m.txt > .pi/scratch/m.txt`,
    `echo x | tee .pi/scratch/m.txt && git commit -F .pi/scratch/m.txt`,
    `git config --file .pi/scratch/m.txt user.name x`,
    `git commit -m -F .pi/scratch/m.txt`,
    `git commit -F m.txt -- .pi/scratch/m.txt`,
    `git commit -- -F .pi/scratch/m.txt`,
    `git commit -F.pi/scratch/m.txt`,
    `git commit -sF .pi/scratch/m.txt`,
    `git notes add -F .pi/scratch/m.txt`,
  ]) assert.equal(sh(cmd), "deny", cmd);
});
