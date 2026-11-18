import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Guards the supply-chain settings: workflow pins, the CI install form, the npm settings, the lockfile URLs and the add-on install environment.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const workflows = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

test("every workflow `uses:` is a full commit hash followed by a version comment", () => {
  assert.ok(workflows.length > 0);
  for (const f of workflows) {
    for (const line of fs.readFileSync(path.join(WORKFLOWS, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/);
      if (!m) continue;
      assert.match(`${m[1]}${m[2]}`, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d[\w.-]*\s*$/, `${f}: ${line.trim()}`);
    }
  }
});

test("no workflow installs from outside the lockfile", () => {
  for (const f of workflows) {
    const text = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
    assert.doesNotMatch(text, /--no-package-lock/, f);
    for (const line of text.split(/\r?\n/)) {
      if (/\bnpm\s+(?:install|i)\b/.test(line)) assert.doesNotMatch(line, /(?:^|\s)(?:-g|--global)(?=\s|$)/, `${f}: ${line.trim()}`);
    }
  }
});

test(".npmrc turns install scripts off and allows root git dependencies", () => {
  const lines = fs.readFileSync(path.join(ROOT, ".npmrc"), "utf8").split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes("ignore-scripts=true"), "ignore-scripts=true missing");
  assert.ok(lines.includes("allow-git=root"), "allow-git=root missing");
});

test("package-lock.json holds no git+ssh URL", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"), /git\+ssh:/);
});

test("setup passes npm_config_ignore_scripts=true to add-on installs only, not to the overlay or other pi calls", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-supply-pins-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  for (const d of [agentDir, cwd, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  const log = path.join(base, "calls.jsonl");
  const r = spawnSync(process.execPath, [SETUP, "--overlay", "npm:@org/overlay@1.2.3", "--agent-dir", agentDir], {
    cwd,
    encoding: "utf8",
    input: "",
    env: {
      ...process.env, CI: "1", PI_FOREMAN_PICKER: "off", PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: log,
      PI_FOREMAN_PI_AI_DATA: path.join(base, "no-models"), PI_FOREMAN_HOME: home, SHELL: "/bin/zsh", PI_FOREMAN_PLATFORM: "linux",
      PI_BG_FEATURES: undefined, npm_config_ignore_scripts: undefined,
    },
  });
  try {
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const addons = calls.filter((c) => c.args[0] === "install" && c.args[1].startsWith("npm:pi-"));
    assert.equal(addons.length, 3, "the three default add-ons are installed");
    for (const c of addons) assert.equal(c.ignoreScripts, "true", c.args.join(" "));
    const overlay = calls.filter((c) => c.args[1] === "npm:@org/overlay@1.2.3");
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].ignoreScripts, undefined, "the overlay install keeps its scripts");
    for (const c of calls.filter((c) => !addons.includes(c))) assert.equal(c.ignoreScripts, undefined, c.args.join(" "));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
