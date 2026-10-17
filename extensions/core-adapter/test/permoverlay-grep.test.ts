import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { bashPath } from "./_bashpath.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-grep-")));
const ws = path.join(w, "ws");
const wt = path.join(w, "ws.worktrees", "hf");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, path.join(wt, "src"), path.join(home, ".ssh")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "notes.txt"), "hi\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const world = (role: "main" | "child"): MatchCtx => ({ cwd: wt, home, platform: process.platform, role });
const sh = (c: MatchCtx, command: string): string => checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
const roles = [world("main"), world("child")];

test("literal 97/31: the regex of grep -nE is no path operand, in the main and the child role", () => {
  for (const c of roles) {
    assert.equal(sh(c, `grep -nE "${home}/\\.ssh/id_[a-z]+" notes.txt`), "pass", c.role);
    assert.equal(sh(c, `grep -nE "/Users/[a-z]+/\\.ssh/id_" notes.txt`), "pass", c.role);
    assert.equal(sh(c, `grep -n -e "${home}/.ssh/id_rsa" -e "x" notes.txt`), "pass", c.role);
    assert.equal(sh(c, `egrep "${home}/.ssh/.*" notes.txt | head`), "pass", c.role);
  }
  // a file operand named like the pattern is still a path
  for (const c of roles) assert.equal(sh(c, `grep -nE "x" ${home}/.ssh/id_rsa`), "deny", c.role);
});

test("git grep: the pattern (bare, -e, -nE, before --) is no path operand", () => {
  for (const c of roles) {
    assert.equal(sh(c, `git grep -n "${home}/.ssh/id_rsa"`), "pass", c.role);
    assert.equal(sh(c, `git grep -nE "/Users/[a-z]+/x" -- src`), "pass", c.role);
    assert.equal(sh(c, `git grep -e "${home}/.ssh/id_rsa" -- src`), "pass", c.role);
    assert.equal(sh(c, `git -C ${bashPath(wt)} grep -nE "${home}/\\.ssh/id_[a-z]+" -- src`), "pass", c.role);
    assert.equal(sh(c, `git grep -nE "x" -- ${bashPath(home)}/.ssh/id_rsa`), "deny", c.role);
  }
});

test("rg -nE: the regex is no path operand; a directory operand still is", () => {
  for (const c of roles) {
    assert.equal(sh(c, `rg -nE "${home}/\\.ssh/id_[a-z]+" src`), "pass", c.role);
    // rg's -E takes an encoding: its value is no path, the next word is the pattern, the one after a path
    assert.equal(sh(c, `rg -nE utf8 "x" ${home}/.ssh`), "deny", c.role);
    assert.equal(sh(c, `rg -n "x" ${home}/.ssh`), "deny", c.role);
  }
});
