// The running-session variables a test entry point must not hand to the tests: the one list is
// extensions/core-adapter/test/session-env.json (keys and prefixes), shared with the node preload and tests/_isolation.py.
import * as fs from "node:fs";

const { keys, prefixes } = JSON.parse(fs.readFileSync(new URL("../extensions/core-adapter/test/session-env.json", import.meta.url), "utf8"));

/** A copy of `env` without the listed session variables; unrelated variables stay. */
export function withoutSessionEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!keys.includes(k) && !prefixes.some((p) => k.startsWith(p))) out[k] = v;
  return out;
}

/** Deletes the listed session variables from `env` in place (the installer preload does this to process.env). */
export function scrubSessionEnv(env) {
  for (const k of Object.keys(env)) if (keys.includes(k) || prefixes.some((p) => k.startsWith(p))) delete env[k];
}
