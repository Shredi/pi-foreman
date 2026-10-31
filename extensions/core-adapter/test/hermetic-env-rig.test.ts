// The shared rig (_r11rig.ts) clears the running-session variables when it loads, so a bare `node --test` (no preload) stays
// hermetic. Proven in a fresh node process: a probe that loads the rig sees no session variable and writes nothing to the handoff dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const rig = pathToFileURL(path.join(here, "_r11rig.ts")).href;

test("the shared rig clears the handoff and parent variables when it loads, without the preload", () => {
  const root = fs.realpathSync(mkTestTmp("pf-hermetic-rig-"));
  try {
    const handoff = path.join(root, "handoff");
    fs.mkdirSync(handoff);
    const probe = path.join(root, "probe.test.mjs");
    fs.writeFileSync(probe, [
      `import { test } from "node:test";`,
      `import assert from "node:assert/strict";`,
      `import ${JSON.stringify(rig)};`,
      `test("the session variables are gone once the rig is loaded", () => {`,
      `  const left = Object.keys(process.env).filter((k) => k === "PI_FOREMAN_HANDOFF_DIR" || k.startsWith("PI_FOREMAN_PARENT_"));`,
      `  assert.deepEqual(left, []);`,
      `  assert.equal(process.env.PI_FOREMAN_PYTHON, "/usr/bin/python3", "PI_FOREMAN_PYTHON is kept on purpose");`,
      `});`,
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { ...process.env, PI_FOREMAN_HANDOFF_DIR: handoff, PI_FOREMAN_PARENT_INTERCOM: "parent-session", PI_FOREMAN_PYTHON: "/usr/bin/python3" };
    delete env.NODE_TEST_CONTEXT; // set by a test runner; it would make the child report in the parent's protocol
    const run = spawnSync(process.execPath, ["--test", probe], { env, cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(fs.readdirSync(handoff), []);
  } finally {
    rmTestTmp(root);
  }
});
