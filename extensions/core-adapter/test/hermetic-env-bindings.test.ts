// The hermetic preload clears PI_SUBAGENT_EXTENSION_BINDINGS, so a suite run inside a subagent child does not inherit the
// child-ask bindings (gate-dialog and the other child-ask tests would otherwise hang). Proven in a fresh node process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, "_hermetic-env.mjs");
const fixture = path.join(here, "fixtures", "print-bindings-env.mjs");

test("the hermetic preload clears PI_SUBAGENT_EXTENSION_BINDINGS in a child process", () => {
  const env = { ...process.env, PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": { foremanSession: "f", workspace: "/w" } }) };
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, fixture], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { bindings: null });
});
