// The presence check cannot see every working login (`claude setup-token` leaves only an env var in the user's own shell), so the hint is conditional.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(fs.realpathSync(path.resolve(HERE, "..", "..")), "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

test("the bridge login hint is worded 'if you are not logged in yet' and keeps both ways to log in", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-bridge-wording-")));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman", "npm:pi-claude-bridge@0.9.2"] })}\n`);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const r = spawnSync(process.execPath, [SETUP, "--dry-run", "--no-addons", "--agent-dir", agentDir], { cwd, encoding: "utf8", env });
    const out = `${r.stdout}${r.stderr}`;
    assert.match(out, /pi-claude-bridge: log in once, if you are not logged in yet\./);
    assert.match(out, /\/login/);
    assert.match(out, /claude setup-token/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
