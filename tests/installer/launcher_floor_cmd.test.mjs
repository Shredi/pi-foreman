// Windows launchers (bin/ledger.cmd, bin/foreman.cmd) refuse Python below 3.13 and name what they found.
// win32 only. PATH holds a fake old py.cmd or python.cmd and System32 (cmd, where), so no real interpreter is reachable.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const win = { skip: process.platform !== "win32" };

const msg = (cmd) => `pi-foreman needs Python 3.13+; found ${cmd} 3.9. Set PI_FOREMAN_PYTHON or install Python 3.13 (macOS: brew install python@3.13).`;

// Answers the floor check (exit 1: too old) and the version probe (prints 3.9).
const SHIM = `@echo off
echo %*| findstr /c:"sys.exit" >nul && exit /b 1
echo %*| findstr /c:"sys.version.split" >nul && (echo 3.9& exit /b 0)
exit /b 0
`;

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-launcher-floor-cmd-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const LAUNCHERS = [
  ["bin\\ledger.cmd", ["sample-arg"]],
  ["bin\\foreman.cmd", ["config", "sample-arg"]],
];

for (const [shim, found] of [["py", "py -3"], ["python", "python"]]) {
  for (const [rel, args] of LAUNCHERS) {
    test(`${rel} reports "found ${found} 3.9" and exits 2 (fake ${shim}.cmd)`, win, () => {
      const dir = path.join(tmp, `${shim}-${path.basename(rel)}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, `${shim}.cmd`), SHIM);
      const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const env = { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: `${dir};${system32}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      const r = spawnSync("cmd.exe", ["/d", "/c", path.join(ROOT, rel), ...args], { encoding: "utf8", env });
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stderr.trim(), msg(found));
    });
  }
}
