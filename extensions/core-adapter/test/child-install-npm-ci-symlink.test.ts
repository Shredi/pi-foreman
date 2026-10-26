// r31: the `npm-ci-worktree` label is not granted when the worktree's node_modules is a symlink (npm ci would wipe the tree it points to).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, npmCiWorktreeLabel, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const win = process.platform === "win32";

test("npm ci in a pi-subagents leaf: the label is granted for a real node_modules, not for a symlinked one", { skip: win }, () => {
  const w = mkTestTmp("pf-r31-npm-ci-link-");
  try {
    const ws = path.join(w, "ws");
    const home = path.join(w, "home");
    const leaf = path.join(w, "worktrees", "ws", "pi-worktree-abc-0");
    const linked = path.join(w, "worktrees", "ws", "pi-worktree-abc-1");
    const main = path.join(w, "main-checkout", "node_modules");
    for (const d of [ws, path.join(home, ".pi", "agent"), leaf, linked, main]) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(ws, ".git"));
    for (const d of [leaf, linked]) {
      fs.writeFileSync(path.join(d, ".git"), "gitdir: /nowhere\n");
      fs.writeFileSync(path.join(d, "package.json"), "{}");
    }
    fs.mkdirSync(path.join(leaf, "node_modules"));
    fs.symlinkSync(main, path.join(linked, "node_modules"));

    const rules = buildOverlayRules(baseline, {}, {}, path.join(home, ".pi", "agent"), ws, undefined, false);
    const ctxOf = (cwd: string): MatchCtx => ({ cwd, home, platform: process.platform, role: "child", roundRoots: [], install: true });

    assert.equal(npmCiWorktreeLabel("npm ci", ctxOf(leaf)), "npm-ci-worktree");
    assert.equal(checkToolCall(rules, "bash", { command: "npm ci" }, ctxOf(leaf)), null);

    assert.equal(npmCiWorktreeLabel("npm ci", ctxOf(linked)), null);
    assert.equal(checkToolCall(rules, "bash", { command: "npm ci" }, ctxOf(linked))?.kind, "ask");
  } finally {
    rmTestTmp(w);
  }
});

test("npm ci in an owned round root: a symlinked node_modules asks, a real one does not", { skip: win }, () => {
  const w = mkTestTmp("pf-r31-npm-ci-owned-");
  try {
    const ws = path.join(w, "ws");
    const home = path.join(w, "home");
    const real = path.join(w, "rt", "real");
    const linked = path.join(w, "rt", "linked");
    const main = path.join(w, "main-checkout", "node_modules");
    for (const d of [ws, path.join(home, ".pi", "agent"), real, linked, main]) fs.mkdirSync(d, { recursive: true });
    for (const d of [real, linked]) fs.writeFileSync(path.join(d, "package.json"), "{}");
    fs.mkdirSync(path.join(real, "node_modules"));
    fs.symlinkSync(main, path.join(linked, "node_modules"));

    const rules = buildOverlayRules(baseline, {}, {}, path.join(home, ".pi", "agent"), ws, undefined, false);
    const ctxOf = (cwd: string): MatchCtx => ({ cwd, home, platform: process.platform, role: "child", roundRoots: [real, linked], install: true });

    assert.equal(checkToolCall(rules, "bash", { command: "npm ci" }, ctxOf(real)), null);
    assert.equal(checkToolCall(rules, "bash", { command: "npm ci" }, ctxOf(linked))?.kind, "ask");
  } finally {
    rmTestTmp(w);
  }
});
