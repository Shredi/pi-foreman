// R11 item 10 on win32: a child's `npm ci|install` into the foreman checkout's bench/pi-lock passes like on POSIX
// (the win32 branch of npmInstallOwned had no foremanRoot allow). Simulated win32 (injected platform, no file system).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASE = "D:\\a\\pf-r11-lock";
const foreman = path.win32.join(BASE, "foreman");
const wt = path.win32.join(BASE, "foreman.worktrees", "r11");
const lock = path.win32.join(foreman, "bench", "pi-lock");
const wHome = path.win32.join(BASE, "home");
const fwd = (p: string): string => p.replace(/\\/g, "/");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, path.win32.join(wHome, ".pi", "agent"), path.win32.join(BASE, "ws"), undefined, false);
const run = (command: string, at = wt, extra: Partial<MatchCtx> = {}): string => {
  const c: MatchCtx = { cwd: at, home: wHome, platform: "win32", role: "child", roundRoots: [wt], foremanRoot: foreman, exists: () => true, isDir: () => true, realpath: (p) => path.win32.resolve(p), realpathNative: (p) => path.win32.resolve(p), list: () => [], ...extra };
  return checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
};

test("npm_ci_bench_pi_lock_foreman_checkout_allowed_win32", () => {
  assert.equal(run(`npm ci --prefix ${fwd(lock)}`), "pass");
  assert.equal(run(`npm install --prefix=${fwd(lock)}`), "pass");
  assert.equal(run("npm ci", lock), "pass");
  assert.equal(run("npm ci", lock, { roundRoots: [] }), "pass");
});

test("npm_install_env_prefix_still_fail_closed_win32", () => {
  assert.equal(run(`npm_config_registry=http://x npm ci --prefix ${fwd(lock)}`), "ask");
  assert.equal(run("PATH=/x npm ci", lock), "ask");
});

test("npm_install_other_dir_still_asks_win32", () => {
  assert.equal(run(`npm ci --prefix ${fwd(foreman)}`), "ask");
  assert.equal(run(`npm ci --prefix ${fwd(path.win32.join(foreman, "bench", "other"))}`), "ask");
  assert.equal(run("npm ci", path.win32.join(foreman, "bench", "other")), "ask");
  assert.equal(run(`npm ci --prefix ${fwd(lock)}`, wt, { foremanRoot: undefined }), "ask");
  assert.equal(run(`npm ci --prefix ${fwd(lock)}/..`), "ask");
});
