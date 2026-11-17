// R5 P2 SEC-fix (ledger 10, 11): the async results root names this foreman's runs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asyncRunDirs } from "../roundsurface.ts";

const posix = process.platform !== "win32";

// F4
test("F4: asyncRunDirs names the results file of a seen run, never the whole results dir", { skip: !posix }, () => {
  const uid = "/t/pi-subagents-uid-501";
  const out = asyncRunDirs([`${uid}/async-subagent-runs/abc/status.json`], "linux");
  assert.deepEqual(out.sort(), [`${uid}/async-subagent-results/abc.json`, `${uid}/async-subagent-runs/abc`].sort());
  assert.ok(!out.includes(`${uid}/async-subagent-results`));
  assert.deepEqual(asyncRunDirs([`${uid}/async-subagent-results`], "linux"), []);
});
