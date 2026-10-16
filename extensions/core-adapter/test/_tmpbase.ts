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
