import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./_sandbox-home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const SLEEPY_PI = path.join(HERE, "fixtures", "sleepy-pi.mjs");

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-timeout-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`);
  return { base, agentDir, cwd, log: path.join(base, "calls.jsonl") };
}

function setup(env, extraEnv) {
  const r = spawnSync(process.execPath, [SETUP, "--no-addons", "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, FAKE_PI_LOG: env.log, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a pi that does not answer `--version` in time gives a timeout message after one retry, never the install hint", () => {
  const env = fresh();
  const r = setup(env, { PI_FOREMAN_PI_BIN: SLEEPY_PI, PI_FOREMAN_PI_VERSION_TIMEOUT_MS: "300", FAKE_PI_SLEEP_MS: "5000" });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /pi did not answer `pi --version` within 0\.3 s/);
  assert.match(r.out, /run `pi --version` once, then rerun setup/);
  assert.doesNotMatch(r.out, /Install Pi|fix PATH/);
  assert.equal(fs.readFileSync(env.log, "utf8").trim().split("\n").length, 2);
});

test("a pi missing from PATH keeps the install hint", { skip: process.platform === "win32" }, () => {
  const env = fresh();
  const empty = path.join(env.base, "empty");
  fs.mkdirSync(empty);
  const r = setup(env, { PI_FOREMAN_PI_BIN: "", PATH: empty });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Could not run pi: .*ENOENT.*Install Pi/s);
  assert.doesNotMatch(r.out, /did not answer/);
});
