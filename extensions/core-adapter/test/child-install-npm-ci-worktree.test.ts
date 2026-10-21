import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, npmCiWorktreeLabel, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-child-npm-ci-wt-")));
const ws = path.join(w, "ws");
const round = path.join(w, "ws.worktrees", "r1");
const leaf = path.join(w, "worktrees", "ws", "pi-worktree-abc-0");
const other = path.join(w, "other");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, round, leaf, other, path.join(leaf, "sub"), ag]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(ws, ".git"));
fs.writeFileSync(path.join(leaf, ".git"), "gitdir: /nowhere\n");
fs.writeFileSync(path.join(leaf, "package.json"), "{}");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ctxOf = (cwd: string): MatchCtx => ({ cwd, home, platform: process.platform, role: "child", roundRoots: [round] });
const run = (cwd: string, command: string): string => checkToolCall(rules, "bash", { command }, ctxOf(cwd))?.kind ?? "pass";
const posix = process.platform === "win32" ? test.skip : test;

posix("npm ci passes in a round worktree and in a pi-subagents leaf, with the label", () => {
  assert.equal(run(round, "npm ci"), "pass");
  assert.equal(run(leaf, "npm ci"), "pass");
  assert.equal(run(path.join(leaf, "sub"), "npm ci"), "pass");
  assert.equal(npmCiWorktreeLabel("npm ci", ctxOf(leaf)), "npm-ci-worktree");
  assert.equal(npmCiWorktreeLabel("npm ci", ctxOf(round)), "npm-ci-worktree");
});

posix("npm ci asks in the parent checkout and in an unrelated dir, no label", () => {
  for (const cwd of [ws, other]) {
    assert.equal(run(cwd, "npm ci"), "ask", cwd);
    assert.equal(npmCiWorktreeLabel("npm ci", ctxOf(cwd)), null, cwd);
  }
});

posix("a leaf runs no npm ci with an extra flag, install, a chain or an env prefix", () => {
  for (const cmd of ["npm ci --ignore-scripts", "npm ci --prefix ..", "npm install", "npm ci && git fetch origin", "npm_config_registry=http://x npm ci"]) {
    assert.equal(run(leaf, cmd), "ask", cmd);
    assert.equal(npmCiWorktreeLabel(cmd, ctxOf(leaf)), null, cmd);
  }
});

posix("a leaf is asked when the npm prefix would climb out of it", () => {
  const bare = path.join(w, "worktrees", "ws", "pi-worktree-abc-1");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, ".git"), "gitdir: /nowhere\n");
  fs.writeFileSync(path.join(w, "worktrees", "package.json"), "{}");
  assert.equal(npmCiWorktreeLabel("npm ci", ctxOf(bare)), null);
});

test("win32 keeps the ask", () => {
  assert.equal(npmCiWorktreeLabel("npm ci", { ...ctxOf(leaf), platform: "win32" }), null);
});
