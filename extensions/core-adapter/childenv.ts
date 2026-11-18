// Child sessions: the env a child's shell commands inherit.
//
// A child never hangs on a login prompt (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never). Its
// credentials stay in the env: a builder from a single launch pushes its own branch like the
// main session. The gate decides who pushes (the child push floor refuses every child that is
// not such a builder; force and protected-branch pushes stay refused for every child).
import type { Env } from "./env.ts";

/**
 * Intercom identity (security review S6): with the foreman's parent id or a fixed intercom id a
 * child could register as the foreman's parent and send foreman:close. PI_FOREMAN_HANDOFF_DIR names
 * the file that holds the parent id of a session opened by `/foreman session open`.
 */
export const CHILD_INTERCOM_UNSET = ["PI_FOREMAN_PARENT_INTERCOM", "PI_FOREMAN_HANDOFF_DIR", "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID"];

/** Remove the intercom identity variables (children, always). */
export function stripChildIntercomEnv(env: Env): void {
  for (const name of CHILD_INTERCOM_UNSET) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  }
}

/**
 * CDPATH (zsh: cdpath) redirects a relative `cd` outside the workspace (security review D-B2); the
 * overlay denies commands that mention it, an inherited value is removed from a child's env.
 */
export const CHILD_CD_UNSET = ["CDPATH"];

/** Remove the cd search path (children, always). */
export function stripChildCdEnv(env: Env): void {
  for (const name of CHILD_CD_UNSET) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  }
}

export const CHILD_SET: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
};

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

/** Patch `env` in place (process.env in the adapter): no login prompt in a child. Idempotent. */
export function patchChildGitEnv(env: Env): void {
  for (const [k, v] of Object.entries(CHILD_SET)) env[keyOf(env, k) ?? k] = v;
}
