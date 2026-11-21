// Per-run temp root for test runs: every temp dir of a run lands in one `pf-run-*` dir that the run removes at its end,
// and a start sweep removes old `pf-*` leftovers of crashed runs. Node only, no deps; the preloads and the runner share it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUN_PREFIX = "pf-run-";
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_CAP = 2000;
const SWEEP_BUDGET_MS = 5000;
/** Persistent cache of scripts/foreman_review_bench.py; never swept. */
const KEEP = new Set(["pf-rb-work"]);

/** The cache base `mkTestTmp` (extensions/core-adapter/test/_tmpbase.ts) falls back to. */
export function cacheBase() {
  return path.join(os.homedir(), ".cache", "pi-foreman-tests");
}

/** The base for run roots: os.tmpdir() (read before any override), or the cache base when it is under literal /tmp or on win32. */
export function realTmpBase() {
  const t = os.tmpdir();
  const underTmp = (() => {
    const r = path.resolve(t);
    return r === "/tmp" || r.startsWith("/tmp/");
  })();
  if (process.platform === "win32" || underTmp) return cacheBase();
  return t;
}

/** Creates `<base>/pf-run-XXXXXX`; returns { root, env } where env is the variables to merge into a child's env. */
export function createRunRoot(base = realTmpBase()) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, RUN_PREFIX));
  const env = { FOREMAN_TEST_TMP_ROOT: root, PI_FOREMAN_TEST_TMP: root };
  // On win32 the test helpers treat the system temp dir as special, so only the helper variables are set there.
  if (process.platform !== "win32") Object.assign(env, { TMPDIR: root, TMP: root, TEMP: root });
  return { root, env };
}

/** Top-level entry names of a run root (for the end warning); [] when it is gone. */
export function leftovers(root) {
  try {
    return fs.readdirSync(root);
  } catch {
    return [];
  }
}

/** Removes a run root; on win32 EBUSY/EPERM/ENOTEMPTY are ignored like `rmTestTmp`. Never throws. */
export function removeRunRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (e) {
    if (process.platform === "win32" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(e?.code)) return;
  }
}

/**
 * Sets up a run root for this process unless FOREMAN_TEST_TMP_ROOT is already set (then returns undefined and removes nothing).
 * Sets the env on `env` (process.env by default) and registers removal on exit. For the preloads and direct runs.
 */
export function ownRunRoot({ env = process.env, sweep = true } = {}) {
  if (env.FOREMAN_TEST_TMP_ROOT) return undefined;
  if (sweep) sweepStale({ bases: sweepBases() });
  const { root, env: add } = createRunRoot(realTmpBase());
  Object.assign(env, add);
  process.on("exit", () => removeRunRoot(root));
  return root;
}

/** The bases a start sweep covers. */
export function sweepBases() {
  return [...new Set([os.tmpdir(), cacheBase()])];
}

/**
 * Removes old `pf-*` entries at the top level of each base: lstat (symlinks are removed as links, never followed), mtime older
 * than maxAgeMs, owned by the current user where getuid exists. Stops after `cap` removals or the time budget; errors per entry are ignored.
 */
export function sweepStale({ bases = sweepBases(), now = Date.now(), maxAgeMs = DAY_MS, cap = SWEEP_CAP, budgetMs = SWEEP_BUDGET_MS } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const t0 = Date.now();
  const result = { removed: 0, scanned: 0 };
  for (const base of bases) {
    let names;
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (result.removed >= cap || Date.now() - t0 > budgetMs) return result;
      if (!name.startsWith("pf-") || KEEP.has(name)) continue;
      result.scanned++;
      const p = path.join(base, name);
      try {
        const st = fs.lstatSync(p);
        if (uid !== undefined && st.uid !== uid) continue;
        if (now - st.mtimeMs <= maxAgeMs) continue;
        fs.rmSync(p, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 250 });
        result.removed++;
      } catch {}
    }
  }
  return result;
}
