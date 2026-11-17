// `foreman pane-resume` through the Windows launchers (bin/foreman.ps1, bin/foreman.cmd): with no HC_TERMINAL_ID the command is silent and exits 0; bad
// arguments exit 2; a PATH without node exits 127 (the shell hook checks again at a later prompt). Windows only; skipped elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const win = process.platform === "win32";
const SYSTEM = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const PS = path.join(SYSTEM, "WindowsPowerShell", "v1.0", "powershell.exe");
const CMD = path.join(SYSTEM, "cmd.exe");

const launchers = {
  ps1: (args, env) => spawnSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "bin", "foreman.ps1"), "pane-resume", ...args], { encoding: "utf8", input: "", env, timeout: 60_000 }),
  cmd: (args, env) => spawnSync(CMD, ["/d", "/c", path.join(ROOT, "bin", "foreman.cmd"), "pane-resume", ...args], { encoding: "utf8", input: "", env, timeout: 60_000 }),
};

for (const [name, run] of Object.entries(launchers)) {
  const env = () => {
    const e = { ...process.env };
    delete e.HC_TERMINAL_ID;
    return e;
  };
  test(`${name}: pane-resume with no HC_TERMINAL_ID is silent and exits 0`, { skip: !win }, () => {
    const r = run(["--shell-pid", "5"], env());
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(`${r.stdout}${r.stderr}`.trim(), "");
  });

  test(`${name}: pane-resume with bad arguments exits 2 and prints the usage`, { skip: !win }, () => {
    const r = run(["--shell-pid", "x"], env());
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /usage: foreman pane-resume --shell-pid <pid>/);
  });

  test(`${name}: pane-resume with no node on PATH exits 127`, { skip: !win }, () => {
    const e = env();
    for (const k of Object.keys(e)) if (k.toLowerCase() === "path") delete e[k];
    const r = run(["--shell-pid", "5"], { ...e, Path: SYSTEM });
    assert.equal(r.status, 127, `${r.stdout}${r.stderr}`);
  });
}
