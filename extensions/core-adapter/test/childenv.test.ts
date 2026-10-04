import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_UNSET, patchChildGitEnv } from "../childenv.ts";
import type { Env } from "../env.ts";

test("child env drops push credentials and injects the git config", () => {
  const env: Env = { PATH: "/usr/bin", SSH_AUTH_SOCK: "/s", SSH_AGENT_PID: "1", GIT_ASKPASS: "a", SSH_ASKPASS: "b",
    GH_TOKEN: "t", github_token: "t", GIT_TOKEN: "t", GIT_SSH_COMMAND: "ssh", GIT_SSH: "ssh", GIT_TERMINAL_PROMPT: "1" };
  patchChildGitEnv(env);
  for (const k of CHILD_UNSET) assert.ok(!Object.keys(env).some((x) => x.toUpperCase() === k), k);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "never");
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.deepEqual([0, 1, 2].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]), [
    ["credential.helper", ""], ["core.sshCommand", "false"], ["url.invalid-push:.pushInsteadOf", ""]]);
});

test("existing GIT_CONFIG_* entries are kept and the patch is idempotent", () => {
  const env: Env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" };
  patchChildGitEnv(env);
  patchChildGitEnv(env);
  assert.equal(env.GIT_CONFIG_COUNT, "4");
  assert.equal(env.GIT_CONFIG_KEY_0, "user.name");
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.equal(env.GIT_CONFIG_KEY_3, "url.invalid-push:.pushInsteadOf");
  assert.equal(env.GIT_CONFIG_KEY_4, undefined);
});

test("a bogus GIT_CONFIG_COUNT is replaced", () => {
  const env: Env = { GIT_CONFIG_COUNT: "x" };
  patchChildGitEnv(env);
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
});
