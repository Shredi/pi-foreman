import { test } from "node:test";
import assert from "node:assert/strict";
import { patchChildGitEnv, stripChildCdEnv, stripChildIntercomEnv } from "../childenv.ts";
import type { Env } from "../env.ts";

test("child env keeps the push credentials and sets only the prompt switches", () => {
  const env: Env = { PATH: "/usr/bin", SSH_AUTH_SOCK: "/s", SSH_AGENT_PID: "1", GIT_ASKPASS: "a", SSH_ASKPASS: "b",
    GH_TOKEN: "t", github_token: "t", GIT_TOKEN: "t", GIT_SSH_COMMAND: "ssh", GIT_SSH: "ssh", GIT_TERMINAL_PROMPT: "1" };
  const before = { ...env };
  patchChildGitEnv(env);
  patchChildGitEnv(env);
  assert.deepEqual(env, { ...before, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  assert.ok(!Object.keys(env).some((k) => k.startsWith("GIT_CONFIG_")), "no injected git config, no invalid-push block");
});

test("existing GIT_CONFIG_* entries are left alone", () => {
  const env: Env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" };
  patchChildGitEnv(env);
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_1, undefined);
});

test("child env drops the intercom identity (review S6), separately from the git patch", () => {
  const env: Env = { PATH: "/usr/bin", PI_FOREMAN_PARENT_INTERCOM: "parent-x", PI_FOREMAN_HANDOFF_DIR: "/h", pi_intercom_stable_id: "fixed" };
  stripChildIntercomEnv(env);
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("child cd: CDPATH is removed from the child env (review D-B2)", () => {
  const env: Record<string, string> = { PATH: "/usr/bin", CDPATH: "/" };
  stripChildCdEnv(env);
  assert.deepEqual(env, { PATH: "/usr/bin" });
});
