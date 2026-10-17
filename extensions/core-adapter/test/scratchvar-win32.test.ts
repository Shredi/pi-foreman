// r9 item 3 (Windows CI id 246): on the runner FOREMAN_SCRATCH is a native path below the 8.3 temp dir
// (`C:\Users\RUNNER~1\AppData\Local\Temp\...\scratch`). expandScratchVar refused any dir with `\` or `~`, so on win32 the variable
// never expanded and `cat f > $FOREMAN_SCRATCH/out` was no deterministic allow. On win32 the dir now goes in as its forward-slash
// spelling, a `~` inside a name is literal; every other shell character, a `~` at a name start and a non-drive dir stay refused.
// Simulated win32 (injected platform, path.win32 strings, no file system); each test is named by its literal line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandScratchVar } from "../childscratch.ts";
import { scratchExpansions } from "../effects.ts";

const W = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-effects-AbC123\\scratch";
const WF = "C:/Users/RUNNER~1/AppData/Local/Temp/pf-effects-AbC123/scratch";

test("win32: ls > /dev/null 2>&1 && cat f > $FOREMAN_SCRATCH/out expands to the forward-slash scratch (id 246)", () => {
  const cmd = "ls > /dev/null 2>&1 && cat f > $FOREMAN_SCRATCH/out";
  assert.equal(expandScratchVar(cmd, W, "win32"), `ls > /dev/null 2>&1 && cat f > ${WF}/out`);
  assert.deepEqual(scratchExpansions(cmd, [W], "win32"), [`ls > /dev/null 2>&1 && cat f > ${WF}/out`]);
  assert.equal(expandScratchVar('cat "${FOREMAN_SCRATCH}/a b"', W, "win32"), `cat "${WF}/a b"`);
});

test("win32: '$FOREMAN_SCRATCH' in single quotes is not expanded", () => {
  assert.equal(expandScratchVar("echo '$FOREMAN_SCRATCH' > $FOREMAN_SCRATCH/o", W, "win32"), `echo '$FOREMAN_SCRATCH' > ${WF}/o`);
});

test("win32: a scratch dir with a shell character, a ~ at a name start or no drive is not expanded (null)", () => {
  const cmd = "cat f > $FOREMAN_SCRATCH/out";
  for (const d of ["C:\\Users\\a b\\s", "C:\\Users\\$x\\s", "C:\\Users\\~x\\s", "C:\\~\\s", "C:\\Users\\a;b\\s", "C:\\Users\\a`b\\s", "C:\\Users\\a*\\s", "C:\\Users\\a'b\\s", "C:\\Users\\a&b\\s", "C:\\Users\\a(b\\s", "C:\\Users\\a#b\\s", "C:\\Users\\a!b\\s", "C:s", "\\\\srv\\share\\s", "s\\x", "~\\s"]) {
    assert.equal(expandScratchVar(cmd, d, "win32"), null, d);
  }
  assert.deepEqual(scratchExpansions(cmd, ["C:\\Users\\a b\\s"], "win32"), [cmd], "no expansion: the command stays as it is");
});

test("off win32 the rule is unchanged: a dir with \\ or ~ is not expanded, a plain one is", () => {
  const cmd = "cat f > $FOREMAN_SCRATCH/out";
  assert.equal(expandScratchVar(cmd, W, "linux"), null);
  assert.equal(expandScratchVar(cmd, "/t/RUNNER~1/s", "darwin"), null);
  assert.equal(expandScratchVar(cmd, "/t/pfs/s1", "linux"), "cat f > /t/pfs/s1/out");
});
