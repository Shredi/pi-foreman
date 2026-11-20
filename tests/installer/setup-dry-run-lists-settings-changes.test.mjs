// D104: the dry run names each settings.json write the real run makes (the remote `setup --dry-run` of `foreman machine setup --dry-run` prints it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./_sandbox-home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(fs.realpathSync(path.resolve(HERE, "..", "..")), "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

test("a dry run lists the settings.json changes it would make and writes nothing", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dry-settings-")));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(cwd);
    const settingsFile = path.join(agentDir, "settings.json");
    const text = `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`;
    fs.writeFileSync(settingsFile, text);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA };
    const r = spawnSync(process.execPath, [SETUP, "--dry-run", "--no-addons", "--agent-dir", agentDir], { cwd, encoding: "utf8", env });
    const out = `${r.stdout}${r.stderr}`;
    assert.match(out, /would change .*settings\.json: .*subagents block/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), text);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
