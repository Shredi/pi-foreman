// The hermetic preload clears the shared session list (session-env.json) and its prefix families, so a suite started from a
// live Pi session does not inherit them. PI_FOREMAN_PYTHON is the one test switch it keeps (Windows CI sets it from outside).
// Proven in a fresh node process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, "_hermetic-env.mjs");
const SESSION = {
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": { foremanSession: "f", workspace: "/w" } }),
  PI_FOREMAN_PARENT_LABEL: "label",
  PI_FOREMAN_PRESSURE_FIXTURE: "/fixture.json",
  PI_INTERCOM_STABLE_ID: "fm-demo-abc123",
  PI_FOREMAN_PLAN_PHASE: "1",
  HERDR_PANE_ID: "w1:p1",
  HC_SESSION: "hc",
};

test("the hermetic preload clears the session variables and prefix families in a child process", () => {
  const env = { ...process.env, ...SESSION, PI_FOREMAN_PYTHON: "/usr/bin/python3" };
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout) as string[];
  for (const k of Object.keys(SESSION)) assert.ok(!seen.includes(k), `${k} reached the child`);
  assert.ok(seen.includes("PI_FOREMAN_PYTHON"), "PI_FOREMAN_PYTHON is kept on purpose");
});
