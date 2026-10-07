// Child sessions: an env in which git cannot authenticate a push (security review S9).
//
// A child with write tools can edit package.json, conftest.py or .git/config and then run an
// allowed command (npm test, pytest, git status) that executes its code without a prompt.
// The guards cannot see that code, so the push credentials are taken out of the env every
// shell command and every guard of the child inherits (Pi's bash and powershell tools build
// their env from process.env at each command start). Consequence: children cannot fetch from
// private remotes or use gh either; the foreman does network git.
//
// Limits (other layers hold there):
// - Direct ssh with an unencrypted key: core.sshCommand=false stops git's own ssh, but code
//   the child runs can call ssh (or a library) with a key file under ~/.ssh itself. The path
//   overlay's deny on ~/.ssh covers the direct tool and shell forms.
// - A remote.<n>.pushurl is not rewritten by pushInsteadOf (git applies it to url only).
//   The git guard's child push block and the deny on child writes to .git/config (review
//   S1/S7, other safety-wave items) are the layers that keep a child from using or planting one.
import type { Env } from "./env.ts";

/**
 * Intercom identity (security review S6): with the foreman's parent id or a fixed intercom id a
 * child could register as the foreman's parent and send foreman:close.
 */
export const CHILD_INTERCOM_UNSET = ["PI_FOREMAN_PARENT_INTERCOM", "PI_INTERCOM_STABLE_ID"];

/** Remove the intercom identity variables (children, always; also when safety.children.mayPush). */
export function stripChildIntercomEnv(env: Env): void {
  for (const name of CHILD_INTERCOM_UNSET) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  }
}

/** Variables that carry or reach push credentials (and intercom identity); removed from a child's env. */
export const CHILD_UNSET = [
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "SSH_ASKPASS",
  "GH_TOKEN", "GITHUB_TOKEN", "GIT_TOKEN",
  // GIT_SSH_COMMAND outranks core.sshCommand; GIT_SSH is the older form of it.
  "GIT_SSH_COMMAND", "GIT_SSH",
  ...CHILD_INTERCOM_UNSET,
];

export const CHILD_SET: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
};

/**
 * Git config injected through GIT_CONFIG_COUNT (highest precedence after `-c`):
 * - credential.helper= : an empty value resets the helper list (system keychain helpers too);
 * - core.sshCommand=false : every ssh transport fails, so ssh push (and ssh fetch) cannot run;
 * - url.invalid-push:.pushInsteadOf= : the empty prefix matches every URL, so each push URL
 *   becomes `invalid-push:<url>`, an unknown transport, and the push fails before any network
 *   access. It touches push URLs only: fetch, commit, diff, status and local branches work.
 */
export const CHILD_GIT_CONFIG: Array<[string, string]> = [
  ["credential.helper", ""],
  ["core.sshCommand", "false"],
  ["url.invalid-push:.pushInsteadOf", ""],
];

function keyOf(env: Env, name: string): string | undefined {
  return Object.keys(env).find((k) => k.toUpperCase() === name);
}

/**
 * Append `entries` to the GIT_CONFIG_COUNT/KEY/VALUE list in `env`. Existing entries are kept;
 * idempotent: when the same block already is the tail of the list (so it still wins), nothing is added.
 */
export function appendGitConfigEnv(env: Env, entries: Array<[string, string]>): void {
  const countKey = keyOf(env, "GIT_CONFIG_COUNT") ?? "GIT_CONFIG_COUNT";
  const raw = env[countKey];
  let n = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  const at = (i: number): [string | undefined, string | undefined] => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]];
  const m = entries.length;
  if (n >= m && entries.every(([k, v], j) => { const [ek, ev] = at(n - m + j); return ek === k && ev === v; })) return;
  for (const [k, v] of entries) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n += 1;
  }
  env[countKey] = String(n);
}

/** Patch `env` in place (process.env in the adapter). Idempotent; existing GIT_CONFIG_* entries are kept. */
export function patchChildGitEnv(env: Env): void {
  for (const name of CHILD_UNSET) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  }
  for (const [k, v] of Object.entries(CHILD_SET)) env[keyOf(env, k) ?? k] = v;
  // A nested child inherits the patched env: the block is found and not appended twice.
  appendGitConfigEnv(env, CHILD_GIT_CONFIG);
}
