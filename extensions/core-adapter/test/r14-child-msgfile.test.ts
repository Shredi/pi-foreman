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
    // R14 ruling 5 flips the `git tag -a v1 -F .pi/scratch/m.txt` row to DENY: child_git_tag_F_protected_path_denied_own_reason
    `git commit -F .workflow/scratch/m.txt`,
  ]) assert.equal(sh(cmd), "pass", `${cmd}: ${checkToolCall(rules, "bash", { command: cmd }, child)?.reason}`);
});

// R14 ruling 2a: the message-file exemption lifts only the write protection; the child read-block (handoffs, other children's scratch)
// still sees the -F operand, so `git tag -a v -F <handoff>` (git_guard lints only commits) and `git commit -F <blocked>` stay denied.
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const scratchRoot = path.join(w, "tmp", "pi-foreman-scratch");
const ownScratch = path.join(scratchRoot, "s1", "Lown");
const otherScratch = path.join(scratchRoot, "s1", "Lother");
const handoff = path.join(ag, "pi-foreman", "handoffs", "s1", "handoff.md");
for (const d of [ownScratch, otherScratch, path.dirname(handoff)]) fs.mkdirSync(d, { recursive: true });
for (const f of [path.join(ownScratch, "m.txt"), path.join(otherScratch, "m.txt"), handoff, path.join(ws, ".workflow", "scratch", "m.txt")]) fs.writeFileSync(f, "subject\n");
const rulesB: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false, { readWrite: [], readOnly: [], childScratchRoot: scratchRoot });
const childB: MatchCtx = { ...child, scratch: ownScratch };
const shB = (command: string): { kind: string; reason?: string } => { const d = checkToolCall(rulesB, "bash", { command }, childB); return { kind: d?.kind ?? "pass", reason: d?.reason }; };

test("child_git_tag_F_handoff_file_denied", () => {
  const d = shB(`git tag -a v -F ${inBash(handoff)}`);
  assert.equal(d.kind, "deny");
  assert.match(d.reason!, /handoff, artifact and configuration paths/);
});

test("child_git_commit_F_handoff_file_denied", () => {
  for (const cmd of [`git commit -F ${inBash(handoff)}`, `git commit --file=${inBash(handoff)}`]) {
    const d = shB(cmd);
    assert.equal(d.kind, "deny", cmd);
    assert.match(d.reason!, /handoff, artifact and configuration paths/, cmd);
  }
});

test("child_git_commit_F_other_child_scratch_denied", () => {
  const d = shB(`git commit -F ${inBash(path.join(otherScratch, "m.txt"))}`);
  assert.equal(d.kind, "deny");
  assert.match(d.reason!, /pi-foreman-scratch/);
});

test("child_git_commit_F_pi_scratch_reaches_git_guard_not_write_protection", () => {
  // the overlay passes it on; git_guard refuses it (tests/test_git_guard_child_commit_f.py test_child_f_pi_scratch_refused_with_git_guard_reason)
  assert.deepEqual(shB(`git commit -F .pi/scratch/m.txt`), { kind: "pass", reason: undefined });
});

test("child_git_commit_F_workflow_and_own_scratch_pass", () => {
  for (const cmd of [`git commit -F .workflow/scratch/m.txt`, `git commit -F ${inBash(path.join(ownScratch, "m.txt"))}`, `git commit -F $FOREMAN_SCRATCH/m.txt`]) {
    assert.equal(shB(cmd).kind, "pass", `${cmd}: ${shB(cmd).reason}`);
  }
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

// R14 ruling 5: the exemption is for `git commit -F/--file` only and lifts only `{cwd}/.pi/*`; a `git tag -F` message file keeps every
// protect rule (the overlay decides, with its own reason), and a commit message file naming another protect.ask path stays protected.
const otherTrace = path.join(ag, "pi-foreman", "state", "trace-other-sid.jsonl");
fs.mkdirSync(path.dirname(otherTrace), { recursive: true });
fs.writeFileSync(otherTrace, "{}\n");

test("child_git_tag_F_protected_path_denied_own_reason", () => {
  for (const cmd of [`git tag -a v -F .pi/scratch/m.txt`, `git tag -a v --file=.pi/scratch/m.txt`, `git tag -a v -F ${inBash(otherTrace)}`]) {
    const d = shB(cmd);
    assert.equal(d.kind, "deny", cmd);
    assert.match(d.reason!, /git tag message file/, cmd);
  }
});

test("child_git_commit_F_other_session_state_trace_denied", () => {
  for (const cmd of [`git commit -F ${inBash(otherTrace)}`, `git commit --file=${inBash(otherTrace)}`, `git commit -F ${inBash(path.join(ag, "settings.json"))}`, `git commit -F ${inBash(path.join(ag, "intercom", "x.json"))}`]) {
    const d = shB(cmd);
    assert.equal(d.kind, "deny", cmd);
    assert.doesNotMatch(d.reason!, /\{cwd\}\/\.pi\/\*/, cmd);
  }
});

test("child_git_commit_F_pkgroot_file_passes_only_as_message_file", () => {
  // the fixture's package root is the worktree: its writeAsk pair is lifted for the commit message-file operand only
  assert.equal(shB(`git commit -F docs/pkg-notes.txt`).kind, "pass");
  for (const cmd of [`git commit -F docs/pkg-notes.txt; touch docs/pkg-notes.txt`, `git commit -F docs/pkg-notes.txt -- docs/pkg-notes.txt`, `git commit -F docs/pkg-notes.txt && cat docs/pkg-notes.txt`, `cp m.txt docs/pkg-notes.txt && git commit -F docs/pkg-notes.txt`, `git tag -a v -F docs/pkg-notes.txt`]) {
    assert.equal(shB(cmd).kind, "deny", cmd);
  }
});

test("child_git_tag_F_own_scratch_passes", () => {
  // (the fixture's worktree is the package root, so a tag message file inside it meets the writeAsk rule: no exemption for tags)
  assert.equal(shB(`git tag -a v -F ${inBash(path.join(ownScratch, "m.txt"))}`).kind, "pass");
});
