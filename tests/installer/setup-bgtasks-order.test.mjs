// pi-foreman must load before pi-background-tasks: its factory sets PI_BG_SHELL* before the add-on reads them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

test("setup moves pi-foreman before pi-background-tasks in packages, a rerun is a no-op", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-installer-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  const file = path.join(agentDir, "settings.json");
  fs.writeFileSync(file, `${JSON.stringify({ packages: ["npm:pi-background-tasks@2.6.10", "npm:some-provider@1.2.3", FOREMAN] })}\n`);
  const run = () => spawnSync(process.execPath, [SETUP, "--no-addons", "--agent-dir", agentDir], {
    cwd, encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA },
  });
  try {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pk = JSON.parse(fs.readFileSync(file, "utf8")).packages;
    assert.ok(pk.indexOf(FOREMAN) >= 0 && pk.indexOf(FOREMAN) < pk.indexOf("npm:pi-background-tasks@2.6.10"), JSON.stringify(pk));
    const before = fs.readFileSync(file, "utf8");
    assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(`${base}-calls.jsonl`, { force: true });
  }
});
