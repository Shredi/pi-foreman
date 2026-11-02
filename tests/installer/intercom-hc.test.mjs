// setup.mjs --intercom-hc / --machine-name: crossMachine.transport "hc" in the pi-intercom config.
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

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-installer-hc-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  return { base, agentDir, cwd, log: `${base}-calls.jsonl`, cfg: path.join(agentDir, "intercom", "config.json") };
}

function run(env, args) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const readCfg = (env) => JSON.parse(fs.readFileSync(env.cfg, "utf8"));

test("without --intercom-hc no crossMachine key is written", () => {
  const env = fresh();
  assert.equal(run(env, []).code, 0);
  assert.equal("crossMachine" in readCfg(env), false);
});

test("--intercom-hc --machine-name creates the config with the hc keys, warns, dry run writes nothing", () => {
  const env = fresh();
  const dry = run(env, ["--dry-run", "--intercom-hc", "--machine-name", "<machine>"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /\+\s+"transport": "hc"/);
  assert.equal(fs.existsSync(env.cfg), false);
  const r = run(env, ["--intercom-hc", "--machine-name", "<machine>"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warning: .*sets crossMachine/);
  assert.deepEqual(readCfg(env), { inboundTrigger: "always", busyDelivery: "human-first", crossMachine: { transport: "hc", machineName: "<machine>" } });
});

test("--intercom-hc merges into an existing config, keeps other keys, and is idempotent", () => {
  const env = fresh();
  fs.mkdirSync(path.dirname(env.cfg), { recursive: true });
  const own = { inboundTrigger: "replies", crossMachine: { remoteCommand: "x" } };
  fs.writeFileSync(env.cfg, JSON.stringify(own));
  const r = run(env, ["--intercom-hc"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warning: .*sets crossMachine/);
  assert.deepEqual(readCfg(env), { ...own, crossMachine: { remoteCommand: "x", transport: "hc" } });
  const settled = fs.readFileSync(env.cfg, "utf8");
  const again = run(env, ["--intercom-hc"]);
  assert.equal(again.code, 0, again.out);
  assert.equal(fs.readFileSync(env.cfg, "utf8"), settled);
  assert.doesNotMatch(again.out, /setting crossMachine/);
});

const foremanJson = (env) => JSON.parse(fs.readFileSync(path.join(env.agentDir, "foreman.json"), "utf8"));

test("--intercom-hc leaves intercom.allowRemote in foreman.json untouched (absent stays absent, a preset value stays)", () => {
  const plain = fresh();
  assert.equal(run(plain, []).code, 0);
  const hc = fresh();
  assert.equal(run(hc, ["--intercom-hc"]).code, 0);
  assert.deepEqual(foremanJson(hc), foremanJson(plain));
  const preset = fresh();
  fs.writeFileSync(path.join(preset.agentDir, "foreman.json"), JSON.stringify({ intercom: { allowRemote: true } }));
  assert.equal(run(preset, ["--intercom-hc"]).code, 0);
  assert.equal(foremanJson(preset).intercom.allowRemote, true);
});

test("--machine-name refuses an empty, whitespace-only or flag-like value and trims the rest", () => {
  const env = fresh();
  for (const bad of ["", "   ", "--no-intercom"]) {
    const r = run(env, ["--intercom-hc", "--machine-name", bad]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--machine-name/);
  }
  assert.equal(fs.existsSync(env.cfg), false);
  assert.equal(run(env, ["--intercom-hc", "--machine-name", "  box  "]).code, 0);
  assert.equal(readCfg(env).crossMachine.machineName, "box");
});

test("--machine-name needs --intercom-hc; --intercom-hc refuses --no-intercom; help lists both", () => {
  const env = fresh();
  assert.equal(run(env, ["--machine-name", "m"]).code, 2);
  assert.equal(run(env, ["--intercom-hc", "--no-intercom"]).code, 2);
  const help = run(env, ["--help"]).out;
  assert.match(help, /--intercom-hc/);
  assert.match(help, /--machine-name/);
});
