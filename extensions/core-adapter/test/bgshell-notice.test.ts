// The no-bash notice decision for background commands on win32 (bgshell.ts): pure, spawn-free, no rig.
// Once-per-session comes from notifyOnce in index.ts (Session.notified); notifyOnce is a closure inside the adapter factory, so it is not called here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_BG_BASH_NOTICE, bgBashNotice, resolveBgShell } from "../bgshell.ts";

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const none = () => { throw new Error("No bash shell found"); };
const found = () => ({ shell: BASH, args: [] });

test("win32, no bash found, neither variable set: the notice", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(bgBashNotice(resolveBgShell({ platform: "win32", env, getShellConfig: none }), false), NO_BG_BASH_NOTICE);
  assert.deepEqual(env, {});
});

test("no notice when bash is found, when the user set either variable, off win32, or in a child session", () => {
  assert.equal(bgBashNotice(resolveBgShell({ platform: "win32", env: {}, getShellConfig: found, exists: () => true }), false), null);
  assert.equal(bgBashNotice(resolveBgShell({ platform: "win32", env: { PI_BG_SHELL: "powershell" }, getShellConfig: none }), false), null);
  assert.equal(bgBashNotice(resolveBgShell({ platform: "win32", env: { PI_BG_SHELL_PATH: "X:\\b.exe" }, getShellConfig: none }), false), null);
  assert.equal(bgBashNotice(resolveBgShell({ platform: "linux", env: {}, getShellConfig: none }), false), null);
  assert.equal(bgBashNotice(resolveBgShell({ platform: "win32", env: {}, getShellConfig: none }), true), null);
});

test("resolveBgShell reports noBash for a missing or non-bash shell and not for a set variable", () => {
  assert.deepEqual(resolveBgShell({ platform: "win32", env: {}, getShellConfig: none }), { set: false, noBash: true });
  assert.deepEqual(resolveBgShell({ platform: "win32", env: {}, getShellConfig: found, exists: () => false }), { set: false, noBash: true });
  assert.deepEqual(resolveBgShell({ platform: "win32", env: {}, getShellConfig: found, exists: () => true }), { set: true, noBash: false });
  assert.deepEqual(resolveBgShell({ platform: "win32", env: { PI_BG_SHELL: "x" }, getShellConfig: none }), { set: false, noBash: false });
});
