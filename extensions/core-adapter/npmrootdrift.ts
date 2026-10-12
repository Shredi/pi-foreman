// npm root drift (R3b point 8c; docs/permissions.md, "Global npm root"). The permission policy is rendered
// by `foreman setup` with the npm root found then (scripts/permissions_gen.py). When `npm root -g` resolves
// to another root later, the policy does not grant it: reads there are asked. This module compares the two
// and names both. It only reads the policy; the persistent re-render stays `foreman setup`.
import * as fs from "node:fs";

/** A resolved npm root that the rendered policy grants a different root than. */
export interface NpmRootDrift {
  resolved: string;
  rendered: string;
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** The rendered policy as read back (read only); null when absent or unreadable. */
export function readPolicy(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The npm root the policy grants: a key of `permission.external_directory_read` that ends in `node_modules`
 * and has its `<key>/*` twin (the two `{npmRoot}` patterns of config/permissions.baseline.json). Null when absent.
 */
export function grantedNpmRoot(config: unknown): string | null {
  const perm = (config as { permission?: { external_directory_read?: unknown } } | null)?.permission;
  const read = perm?.external_directory_read;
  if (!read || typeof read !== "object") return null;
  const keys = Object.keys(read).map(norm);
  const hit = keys.find((k) => /\/node_modules$/.test(k) && keys.includes(`${k}/*`));
  return hit ?? null;
}

/**
 * The drift to report, or null: nothing resolved, the policy grants the resolved root, or it grants no npm
 * root at all (an open or unrendered policy stays silent).
 */
export function npmRootDrift(resolved: string | null, config: unknown): NpmRootDrift | null {
  if (!resolved) return null;
  const want = norm(resolved);
  const rendered = grantedNpmRoot(config);
  return rendered && rendered !== want ? { resolved: want, rendered } : null;
}

/**
 * The warning for a drift, once per session: `seen` is the session's notified set. Null when there is no
 * drift or the warning was already given.
 */
export function npmRootDriftNotice(drift: NpmRootDrift | null, seen: Set<string>): string | null {
  if (!drift || seen.has("npm-root-drift")) return null;
  seen.add("npm-root-drift");
  return `pi-foreman: npm root drifted: run \`foreman setup\` (resolved ${drift.resolved}; policy grants ${drift.rendered})`;
}
