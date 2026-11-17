// Ledger r8 item 6: the Windows CI shapes of permoverlay-vars (721, 723, 724) and shellvars-cases (1145, 1148), simulated on
// every host: the fixture paths spelled by bashPath. (The permission overlay these shapes were run against is gone; the helper stays.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashPath, bashQuoted } from "./_bashpath.ts";

test("bashPath / bashQuoted: forward slashes or double quotes on win32, unchanged elsewhere", () => {
  assert.equal(bashPath("C:\\Users\\RUNNER~1\\x", "win32"), "C:/Users/RUNNER~1/x");
  assert.equal(bashQuoted("C:\\Users\\x", "win32"), '"C:\\Users\\x"');
  for (const platform of ["linux", "darwin"]) {
    assert.equal(bashPath("/tmp/a\\b", platform), "/tmp/a\\b");
    assert.equal(bashQuoted("/tmp/a", platform), "/tmp/a");
  }
});
