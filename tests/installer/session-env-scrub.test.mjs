// The running-session variables (extensions/core-adapter/test/session-env.json) do not reach the tests started by the wrapper,
// the replay runner or the installer preload; unrelated variables do.
import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shared = JSON.parse(fs.readFileSync(path.join(ROOT, "extensions", "core-adapter", "test", "session-env.json"), "utf8"));
const SESSION = {
  ...Object.fromEntries(shared.keys.map((k) => [k, "x"])),
  ...Object.fromEntries(shared.prefixes.map((p) => [`${p}EXTRA`, "x"])),
};
const KEEP = { PF_UNRELATED_VAR: "kept", PI_FOREMAN_PYTHON: "py" };
const PRINT = "process.stdout.write(JSON.stringify(process.env))";

function baseEnv(extra) {
  const e = { ...process.env, ...SESSION, ...KEEP, ...extra };
  delete e.CI;
  delete e.NODE_TEST_CONTEXT;
  return e;
}

function assertScrubbed(seen) {
  for (const k of Object.keys(SESSION)) assert.ok(!(k in seen), `${k} reached the command`);
  for (const [k, v] of Object.entries(KEEP)) assert.equal(seen[k], v, `${k} is kept`);
}

test("the list covers the plan flag, the tool packs, the subagent runtime and the scratch variables", () => {
  for (const k of ["PI_FOREMAN_PLAN_PHASE", "PI_FOREMAN_TOOL_PACKS", "PI_FOREMAN_RESUMED", "FOREMAN_SCRATCH", "FOREMAN_OUT", "FOREMAN_CHECKOUT"]) {
    assert.ok(shared.keys.includes(k), k);
  }
  assert.ok(shared.prefixes.includes("PI_SUBAGENTS_"));
  assert.ok(!shared.keys.some((k) => k.startsWith("GIT_")), "the child git env stays out of the list");
});

test("foreman_test_run --exec gives the command an env without the session variables", () => {
  const lockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scrub-lock-")));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "foreman_test_run.mjs"), "--exec", "--", process.execPath, "-e", PRINT], {
      env: baseEnv({ FOREMAN_TEST_LOCK_DIR: lockDir }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assertScrubbed(JSON.parse(r.stdout));
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("foreman_test_run in node mode scrubs the env of the test process too", () => {
  const lockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scrub-lock-")));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scrub-node-")));
  try {
    fs.writeFileSync(path.join(dir, "probe.test.mjs"), `import { test } from "node:test";\nimport * as fs from "node:fs";\ntest("p", () => fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify(process.env)));\n`);
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "foreman_test_run.mjs"), path.join(dir, "probe.test.mjs")], {
      env: baseEnv({ FOREMAN_TEST_LOCK_DIR: lockDir }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assertScrubbed(JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")));
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay_run gives its unittest modules an env without the session variables", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scrub-replay-")));
  try {
    fs.writeFileSync(
      path.join(dir, "test_probe.py"),
      `import json, os, unittest\n\nclass T(unittest.TestCase):\n    def test_env(self):\n        with open(os.environ["PF_PROBE_OUT"], "w") as f:\n            json.dump(dict(os.environ), f)\n`,
    );
    const out = path.join(dir, "env.json");
    const py = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "replay_run.mjs"), "--dir", dir, "--serial", ""], {
      env: baseEnv({ PF_PROBE_OUT: out, PI_FOREMAN_PYTHON: py }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    for (const k of Object.keys(SESSION)) assert.ok(!(k in seen), `${k} reached the module`);
    assert.equal(seen.PF_UNRELATED_VAR, "kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the installer preload removes the session variables and still sets HERDR_APP_HOME", () => {
  const preload = pathToFileURL(path.join(ROOT, "tests", "installer", "_hermetic-env.mjs")).href;
  const r = spawnSync(process.execPath, ["--import", preload, "-e", PRINT], { env: baseEnv({ HERDR_APP_HOME: "/session/app-home" }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  for (const k of Object.keys(SESSION)) if (k !== "HERDR_APP_HOME") assert.ok(!(k in seen), `${k} reached the child`);
  assert.ok(seen.HERDR_APP_HOME && seen.HERDR_APP_HOME !== "/session/app-home", "HERDR_APP_HOME is the preload's temp dir");
  assert.equal(seen.PF_UNRELATED_VAR, "kept");
});
