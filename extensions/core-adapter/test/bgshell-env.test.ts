import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBgShellEnv } from "../bgshell.ts";

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const cfg = (shell = BASH) => () => ({ shell, args: ["-c"] });

test("win32, both unset, bash exists: sets both", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyBgShellEnv({ platform: "win32", env, getShellConfig: cfg(), exists: () => true }), true);
  assert.deepEqual(env, { PI_BG_SHELL: "bash", PI_BG_SHELL_PATH: BASH });
});

test("not win32: nothing set", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyBgShellEnv({ platform: "linux", env, getShellConfig: cfg(), exists: () => true }), false);
  assert.deepEqual(env, {});
});

test("either variable already set: untouched", () => {
  for (const pre of [{ PI_BG_SHELL: "powershell" }, { PI_BG_SHELL_PATH: "X:\\b.exe" }]) {
    const env: NodeJS.ProcessEnv = { ...pre };
    assert.equal(applyBgShellEnv({ platform: "win32", env, getShellConfig: cfg(), exists: () => true }), false);
    assert.deepEqual(env, pre);
  }
});

test("bash not found, relative, missing or stdin transport: nothing set", () => {
  const cases = [
    { getShellConfig: () => { throw new Error("no bash"); }, exists: () => true },
    { getShellConfig: cfg("bash"), exists: () => true },
    { getShellConfig: cfg(), exists: () => false },
    { getShellConfig: () => ({ shell: BASH, args: [], commandTransport: "stdin" }), exists: () => true },
  ];
  for (const c of cases) {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(applyBgShellEnv({ platform: "win32", env, ...c }), false);
    assert.deepEqual(env, {});
  }
});

test("shellPath setting is passed to getShellConfig", () => {
  let seen: string | undefined;
  applyBgShellEnv({ platform: "win32", env: {}, shellPath: "D:\\git\\bash.exe", getShellConfig: (p) => ((seen = p), { shell: BASH, args: [] }), exists: () => true });
  assert.equal(seen, "D:\\git\\bash.exe");
});
