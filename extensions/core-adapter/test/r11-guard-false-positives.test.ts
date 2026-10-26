// R11 P3 guard false positives (ledger items 7, 9, 10): each fixture has a negative that shows the original block still holds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, "/nonexistent/agent", "/nonexistent/pkg");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cwd = path.join(root, "ws");
const outside = path.join(root, "elsewhere");
const home = path.join(root, "home");
// the foreman checkout holds bench/pi-lock; the child works in a round worktree next to it
const foreman = path.join(root, "foreman");
const wt = path.join(root, "foreman.worktrees", "r11");
for (const d of [cwd, outside, home, path.join(foreman, "bench", "pi-lock"), path.join(foreman, "bench", "other"), wt]) fs.mkdirSync(d, { recursive: true });

const child = (command: string, extra: Partial<MatchCtx> = {}, at = cwd): { kind: string; reason?: string } => {
  const d = checkToolCall(rules, "bash", { command }, { cwd: at, home, platform: process.platform, role: "child", ...extra });
  return { kind: d?.kind ?? "pass", reason: (d as { reason?: string } | null)?.reason };
};
const CD = /children may cd only inside the workspace/;
const BIND = /the line binds HOME and uses it/;

// ---- item 7: the cd guard ignores commit message text
// RECONSTRUCTED: R10 recorded only that a commit message mentioning the variable was refused, not the message itself.
test("cd_guard_commit_message_mentions_cdpath_allowed", () => {
  for (const c of [
    'git commit -m "fix(guard): the cd guard no longer reads CDPATH inside a commit message"',
    "git commit -m 'mentions CDPATH and CDPATH=x only as text'",
    'git commit -m "subject" -m "body about CDPATH"',
    'git commit -am "about CDPATH"',
    'git commit -m"about CDPATH"',
    'git commit --message="about CDPATH"',
    'git commit --message "about CDPATH"',
  ]) assert.doesNotMatch(child(c).reason ?? "", CD, c);
});

test("cd_guard_real_cd_outside_workspace_still_refused", () => {
  for (const c of [`cd ${outside} && git commit -m "x"`, `git commit -m "x" && cd ${outside}`, "cd .. && ls"]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, CD, c);
  }
});

test("cd_guard_cdpath_in_a_live_command_still_refused", () => {
  for (const c of ["CDPATH=/ ls", "export CDPATH=/tmp", 'CDPATH=/ git commit -m "x"', 'git commit -m "x"; export CDPATH=/', "git commit -F CDPATH.txt", 'git commit -m "$(export CDPATH=/)"', 'echo CDPATH']) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, CD, c);
  }
});

// ---- item 9: `=` inside a quoted python -c body binds nothing
// usage-file path neutralised to a temp-like path
const usage = path.join(root, "usage.json");
const body = "import json,sys,os; d=json.load(sys.stdin); x=d['HOME']; print(x, os.path.expanduser('~'))";
test("home_binding_python_c_body_equals_ignored", () => {
  const d = child(`cat ${usage} | python3 -c "${body}"`);
  assert.doesNotMatch(d.reason ?? "", BIND);
});

test("home_binding_real_shell_home_assignment_still_refused", () => {
  for (const c of [`HOME=-i; cat ~/x`, `HOME=/x; cat $HOME/y`, `cat ${usage} | python3 -c "${body}"; HOME=/x; ls ~`, `read HOME; cat ~/x`]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, BIND, c);
  }
});

test("home_binding_env_prefix_on_python_c_still_refused", () => {
  for (const c of [`HOME=/x python3 -c "${body}"`, `HOME=/x python3 -c "print(1)" ~/f`]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, BIND, c);
  }
});

// ---- item 10: child npm ci / install in the foreman checkout's bench/pi-lock
const lock = path.join(foreman, "bench", "pi-lock");
// a path written INTO a bash line: on win32 a child writes forward slashes (unquoted backslashes are bash escapes,
// see the win32 fixtures in r11-npm-lock-win32.test.ts); the ctx paths stay native
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const npm = (command: string, at = wt, extra: Partial<MatchCtx> = {}): string => child(command, { roundRoots: [wt], foremanRoot: foreman, install: true, ...extra }, at).kind; // R46: the pre-allow needs the launch's install flag

test("npm_ci_bench_pi_lock_foreman_checkout_allowed", () => {
  assert.equal(npm(`npm ci --prefix ${inBash(lock)}`), "pass");
  assert.equal(npm(`npm install --prefix=${inBash(lock)}`), "pass");
  assert.equal(npm("npm ci", lock), "pass");
  assert.equal(npm("npm ci", lock, { roundRoots: [] }), "pass");
});

test("npm_install_env_prefix_still_fail_closed", () => {
  assert.equal(npm(`npm_config_registry=http://x npm ci --prefix ${inBash(lock)}`), "ask");
  assert.equal(npm("PATH=/x npm ci", lock), "ask");
});

test("npm_install_other_dir_still_asks", () => {
  assert.equal(npm(`npm ci --prefix ${inBash(foreman)}`), "ask");
  assert.equal(npm(`npm ci --prefix ${inBash(path.join(foreman, "bench", "other"))}`), "ask");
  assert.equal(npm("npm ci", path.join(foreman, "bench", "other")), "ask");
  assert.equal(npm(`npm ci --prefix ${inBash(lock)}`, wt, { foremanRoot: undefined }), "ask");
  assert.equal(npm(`npm ci --prefix ${inBash(lock)}/..`), "ask");
});
