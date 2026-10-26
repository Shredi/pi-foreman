import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const CLI = path.join(ROOT, "scripts", "foreman_features.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";

const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

function fresh(packages = [FOREMAN]) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-features-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages })}\n`);
  return { base, agentDir, cwd, log: `${base}-calls.jsonl` };
}

function cli(env, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA, PI_FOREMAN_PICKER: "off" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const userFile = (env) => path.join(env.agentDir, "foreman.json");
const rowOf = (json, id) => json.features.find((f) => f.id === id);

test("features list shows state, the profile expectation and a deviation marker", () => {
  const env = fresh();
  const none = JSON.parse(cli(env, ["list", "--json"]).stdout);
  assert.equal(none.profile, null);
  assert.equal(rowOf(none, "retro").state, "auto");
  assert.equal(rowOf(none, "git-tools").state, "off");
  assert.equal(rowOf(none, "pr-ops").state, "on");
  assert.equal(rowOf(none, "setup").state, "n/a");
  assert.equal(rowOf(none, "pr-ops").profile, null);

  fs.writeFileSync(userFile(env), JSON.stringify({ version: 1, providers: {}, profile: "orchestration", tools: { pr: true }, herdr: { blockedShim: false, groupTag: false } }));
  const json = JSON.parse(cli(env, ["list", "--json"]).stdout);
  assert.equal(json.profile, "orchestration");
  assert.deepEqual(rowOf(json, "pr-ops"), { id: "pr-ops", area: "tools", state: "on", profile: "off", deviates: true, toggle: true });
  assert.equal(rowOf(json, "herdr").state, "off");
  assert.equal(rowOf(json, "herdr").deviates, false);
  assert.equal(rowOf(json, "codemode").profile, "on");
  const text = cli(env, ["list"]).out;
  assert.match(text, /^profile: orchestration$/m);
  assert.match(text, /^ {2}pr-ops +tools +on +off \*$/m);
  assert.match(text, /^ {2}herdr +ui +off +off$/m);

  fs.writeFileSync(userFile(env), JSON.stringify({ version: 1, providers: {}, profile: "bogus" }));
  const unknown = JSON.parse(cli(env, ["list", "--json"]).stdout);
  assert.equal(unknown.known, false);
  assert.equal(unknown.features.some((f) => f.deviates), false);
});

test("features addons shows the registry with installed state from both settings files", () => {
  const env = fresh([FOREMAN, "npm:pi-polish@0.1.2"]);
  fs.mkdirSync(path.join(env.cwd, ".pi"));
  fs.writeFileSync(path.join(env.cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-background-tasks"] }));
  const rows = JSON.parse(cli(env, ["addons", "--json"]).stdout);
  assert.deepEqual(rows.map((r) => [r.id, r.installed.map((i) => i.scope)]), [["polish", ["global"]], ["background-tasks", ["project"]]]);
  assert.equal(rows[1].spec, "npm:pi-background-tasks@2.6.10");
  assert.match(cli(env, ["addons"]).out, /polish +npm:pi-polish@0\.1\.2 +installed \(npm:pi-polish@0\.1\.2, global\)/);
});

test("features profile, enable and disable run the whole setup with the matching flags", () => {
  const env = fresh();
  const dry = cli(env, ["profile", "orchestration", "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /pi-foreman installer \(dry run/);
  assert.equal(fs.existsSync(userFile(env)), false);
  const p = cli(env, ["profile", "orchestration"]);
  assert.equal(p.code, 0, p.out);
  assert.equal(JSON.parse(fs.readFileSync(userFile(env), "utf8")).profile, "orchestration");
  const e = cli(env, ["enable", "pr-ops", "herdr"]);
  assert.equal(e.code, 0, e.out);
  const cfg = JSON.parse(fs.readFileSync(userFile(env), "utf8"));
  assert.equal(cfg.tools.pr, true);
  assert.equal(cfg.herdr.blockedShim, true);
  assert.equal(cli(env, ["disable", "codemode"]).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(userFile(env), "utf8")).roles.foreman.codemode, false);
});

test("features: unknown subcommand, missing arguments and unknown ids exit 2", () => {
  const env = fresh();
  assert.equal(cli(env, []).code, 2);
  assert.equal(cli(env, ["nope"]).code, 2);
  assert.equal(cli(env, ["enable"]).code, 2);
  assert.equal(cli(env, ["profile"]).code, 2);
  const bad = cli(env, ["enable", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown feature id nope/);
});
