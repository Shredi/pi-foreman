// The hermetic preload clears the shared session list (session-env.json) and its prefix families, so a suite started from a
// live Pi session does not inherit them. PI_FOREMAN_PYTHON is the one test switch it keeps (Windows CI sets it from outside).
// Proven in a fresh node process.
import { test } from "node:test";
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, "_hermetic-env.mjs");
const shared = JSON.parse(fs.readFileSync(path.join(here, "session-env.json"), "utf8")) as { keys: string[]; prefixes: string[] };
// every key of the shared list plus one name per prefix family, so a key dropped from the JSON fails this test
const SESSION: Record<string, string> = {
  ...Object.fromEntries(shared.keys.map((k) => [k, "x"])),
  ...Object.fromEntries(shared.prefixes.map((p) => [`${p}EXTRA`, "x"])),
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": { foremanSession: "f", workspace: "/w" } }),
};

test("the hermetic preload clears the session variables and prefix families in a child process", () => {
  const env = { ...process.env, ...SESSION, PI_FOREMAN_PYTHON: "/usr/bin/python3" };
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout) as string[];
  for (const k of ["PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "HERDR_ENV", "PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_CHILD"]) assert.ok(k in SESSION, `${k} is set by the test`);
  for (const k of Object.keys(SESSION)) assert.ok(!seen.includes(k), `${k} reached the child`);
  assert.ok(seen.includes("PI_FOREMAN_PYTHON"), "PI_FOREMAN_PYTHON is kept on purpose");
});
