import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bridgeLoginPresent } from "../../setup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(fs.realpathSync(path.resolve(HERE, "..", "..")), "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

function setupOut({ credentials = false, token = "" } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-bridge-login-")));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman", "npm:pi-claude-bridge@0.9.2"] })}\n`);
    if (credentials) {
      fs.mkdirSync(path.join(agentDir, "pi-foreman", "claude-config"), { recursive: true });
      fs.writeFileSync(path.join(agentDir, "pi-foreman", "claude-config", ".credentials.json"), "{}");
    }
    const r = spawnSync(process.execPath, [SETUP, "--dry-run", "--no-addons", "--agent-dir", agentDir], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA, CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    return `${r.stdout}${r.stderr}`;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("bridge hint is absent when the isolation folder holds a credentials file", () => {
  assert.doesNotMatch(setupOut({ credentials: true }), /log in once/);
});

test("bridge hint is absent when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
  assert.doesNotMatch(setupOut({ token: "x" }), /log in once/);
});

test("bridge hint is printed when no login is found", () => {
  assert.match(setupOut(), /pi-claude-bridge: log in once/);
});

test("bridgeLoginPresent consults the keychain on darwin only, with the dir-hashed service", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-bridge-kc-"));
  try {
    const seen = [];
    const probe = (s) => (seen.push(s), true);
    assert.equal(bridgeLoginPresent(agentDir, { env: {}, platform: "darwin", keychain: probe }), true);
    assert.match(seen[0], /^Claude Code-credentials-[0-9a-f]{8}$/);
    assert.equal(bridgeLoginPresent(agentDir, { env: {}, platform: "linux", keychain: probe }), false);
    assert.equal(seen.length, 1);
    assert.equal(bridgeLoginPresent(agentDir, { env: {}, platform: "darwin", keychain: () => false }), false);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
