// Test-fixture temp base that is never under a literal /tmp. The guards add /tmp as a write root on non-win32,
// so a fixture created below /tmp (Linux CI: os.tmpdir() === "/tmp") would be classed tmp-scratch / write-in
// and hide the containment these tests assert. PI_FOREMAN_TEST_TMP overrides the base.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function underTmp(p: string): boolean {
  if (process.platform === "win32") return false;
  const cands = [path.resolve(p)];
  try { cands.push(fs.realpathSync.native(p)); } catch { /* missing dir: literal check only */ }
  return cands.some((c) => c === "/tmp" || c.startsWith("/tmp/"));
}

/** A fresh mkdtemp dir (caller removes it) whose path is not below /tmp. */
export function mkTestTmp(prefix: string): string {
  const env = process.env.PI_FOREMAN_TEST_TMP;
  let root = env && env.trim() ? env : os.tmpdir();
  if (underTmp(root)) root = path.join(os.homedir(), ".cache", "pi-foreman-tests");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

// Captured at load: tests mock setTimeout via t.mock.timers, and an after hook can still run under the mock.
const realSetTimeout = globalThis.setTimeout;

/** Poll until the dir listing (names + sizes) is unchanged for two polls, at most 5 s. Call after the adapter shutdown, before rmTestTmp. */
export async function waitQuiet(dir: string): Promise<void> {
  const snap = (): string => {
    try { return fs.readdirSync(dir).sort().map((n) => `${n}:${fs.statSync(path.join(dir, n)).size}`).join("|"); } catch { return ""; }
  };
  let prev = snap();
  let stable = 0;
  for (let waited = 0; waited < 5000 && stable < 2; waited += 100) {
    await new Promise((r) => realSetTimeout(r, 100));
    const cur = snap();
    stable = cur === prev ? stable + 1 : 0;
    prev = cur;
  }
}

/**
 * Remove a fixture dir. Windows refuses to delete a directory that is the process cwd or is still held by a
 * just-exited child (EBUSY), so step out of it first and retry a few times.
 */
export function rmTestTmp(dir: string): void {
  try {
    const cwd = path.resolve(process.cwd());
    const target = path.resolve(dir);
    if (cwd === target || cwd.startsWith(target + path.sep)) process.chdir(os.tmpdir());
  } catch { /* cwd may already be gone */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (e) {
    // Windows: a detached child can keep the dir open past the retries; a leaked temp dir on a runner is harmless.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")) return;
    throw e;
  }
}
