// remote-windows-2 item 4: `cd /c/x && powershell.exe ...` runs through the git-bash `-c` of foreman_bg on win32.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellFor, spawnDetached } from "../bg.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

const LINE = "cd /c/x && powershell.exe -NoProfile -Command Get-Date";
const bash = { shell: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] };

test("shellFor win32: the cd /c/x && powershell.exe line is one git-bash -c argument", () => {
  const sh = shellFor(LINE, "win32", { getShellConfig: () => bash });
  assert.deepEqual(sh, { file: bash.shell, args: ["-c", LINE], verbatim: false });
});

test("spawnDetached win32: the injected shell receives the line unchanged as its last argument", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-bg-ps-"));
  const out = path.join(d, "argv.json");
  const script = "require('fs').writeFileSync(process.env.PF_OUT, JSON.stringify(process.argv.slice(1)))";
  const r = spawnDetached(LINE, d, path.join(d, "log"), "win32", {
    getShellConfig: () => ({ shell: process.execPath, args: ["-e", script, "--"] }),
    env: { ...process.env, PF_OUT: out },
  });
  assert.ok("pid" in r, JSON.stringify(r));
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
  try {
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), [LINE]);
  } finally {
    // the child may still hold the dir or the log for a moment (Windows EBUSY): wait for its exit, then remove with retries
    for (let i = 0; i < 100 && alive(r.pid); i++) await new Promise((res) => setTimeout(res, 50));
    rmTestTmp(d);
  }
});
