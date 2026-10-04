import { test } from "node:test";
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

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-installer-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  return { base, agentDir, cwd, log: `${base}-calls.jsonl` };
}

function run(env, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

function calls(env) {
  try {
    return fs.readFileSync(env.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args);
  } catch {
    return [];
  }
}
const installs = (env) => calls(env).filter((a) => a[0] === "install" || a[0] === "remove");

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const readSettings = (env) => JSON.parse(fs.readFileSync(path.join(env.agentDir, "settings.json"), "utf8"));
const backups = (env) => fs.readdirSync(env.agentDir).filter((f) => f.startsWith("settings.json.bak-"));
const SEED = { theme: "dark", packages: ["npm:some-provider@1.2.3"], defaultModel: "x/y", zeta: 1, alpha: 2 };

function seed(env, obj = SEED) {
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(obj, null, 2)}\n`);
}

function pythonValidate(env) {
  const [cmd, pre] = process.platform === "win32" ? ["py", ["-3"]] : ["python3", []];
  const r = spawnSync(cmd, [...pre, "-E", "-s", path.join(ROOT, "scripts", "foreman_config.py"), "validate", "--json", "--agent-dir", env.agentDir], { encoding: "utf8" });
  return { code: r.status, data: JSON.parse(r.stdout) };
}

test("dry run writes nothing and runs no install", () => {
  const env = fresh();
  seed(env);
  const before = snapshot(env.base);
  const r = run(env, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(installs(env), []);
  assert.match(r.out, /would run: pi install npm:pi-subagents@0\.75\.0/);
  assert.match(r.out, /would run: pi install /);
  assert.match(r.out, /^\+\+\+ b\/settings\.json/m);
  assert.match(r.out, /permission-system config: absent, would write/);
  assert.equal(fs.existsSync(path.join(env.agentDir, "extensions")), false);
});

test("first run backs up, writes the managed block, keeps user keys in order", () => {
  const env = fresh();
  seed(env);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.equal(backups(env).length, 1);
  const bak = JSON.parse(fs.readFileSync(path.join(env.agentDir, backups(env)[0]), "utf8"));
  assert.deepEqual(bak, SEED);
  const s = readSettings(env);
  assert.deepEqual(Object.keys(s).slice(0, 5), Object.keys(SEED));
  assert.equal(s.theme, "dark");
  assert.equal(s.subagents.agentOverrides.builder.tools.includes("edit"), true);
  assert.equal(s.subagents.forceTopLevelAsync, true);
  assert.ok(s.packages.includes("npm:some-provider@1.2.3"));
  assert.ok(s.packages.includes("npm:pi-subagents@0.75.0"));
  assert.ok(s.packages.includes("npm:@gotgenes/pi-permission-system@39.0.2"));
  assert.equal(s.packages.some((p) => p.includes("ai-guard")), false);
  const managed = JSON.parse(fs.readFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), "utf8"));
  assert.match(Object.values(managed.entries)[0].subagentsHash, /^[0-9a-f]{64}$/);
  const inst = installs(env).map((a) => a[1]);
  assert.deepEqual(inst, ["npm:pi-subagents@0.75.0", "npm:@gotgenes/pi-permission-system@39.0.2", ROOT]);
  assert.match(fs.readFileSync(path.join(env.agentDir, "settings.json"), "utf8"), /^ {2}"theme"/m);
});

test("second run is a no-op: no writes, no installs", () => {
  const env = fresh();
  seed(env);
  assert.equal(run(env, []).code, 0);
  fs.rmSync(env.log);
  const before = snapshot(env.base);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(installs(env), []);
  assert.match(r.out, /up to date/);
});

test("hand-edited block is backed up and overwritten", () => {
  const env = fresh();
  seed(env);
  assert.equal(run(env, []).code, 0);
  const s = readSettings(env);
  s.subagents.agentOverrides.builder.tools = ["read"];
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  const before = backups(env).length;
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /edited by hand/);
  assert.equal(backups(env).length, before + 1);
  const newest = backups(env).sort().pop();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.agentDir, newest), "utf8")).subagents.agentOverrides.builder.tools, ["read"]);
  assert.equal(readSettings(env).subagents.agentOverrides.builder.tools.length > 1, true);
});

test("foreman.json template is written only if absent and validates cleanly", () => {
  const env = fresh();
  assert.equal(run(env, []).code, 0);
  const v = pythonValidate(env);
  assert.equal(v.code, 0);
  assert.deepEqual(v.data.warnings, []);
  assert.deepEqual(v.data.errors, []);

  const env2 = fresh();
  const mine = '{"version": 1, "providers": {}, "fanout": {"max": 2}}\n';
  fs.writeFileSync(path.join(env2.agentDir, "foreman.json"), mine);
  assert.equal(run(env2, []).code, 0);
  assert.equal(fs.readFileSync(path.join(env2.agentDir, "foreman.json"), "utf8"), mine);
});

test("--remove drops only managed entries", () => {
  const env = fresh();
  seed(env);
  assert.equal(run(env, []).code, 0);
  const s = readSettings(env);
  s.subagents.extraUserKey = true;
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  const r = run(env, ["--remove"]);
  assert.equal(r.code, 0, r.out);
  const after = readSettings(env);
  assert.equal(after.subagents.agentOverrides, undefined);
  assert.equal(after.subagents.agentOverridesByProvider, undefined);
  assert.equal(after.subagents.forceTopLevelAsync, undefined);
  assert.equal(after.subagents.extraUserKey, true);
  assert.equal(after.theme, "dark");
  assert.ok(after.packages.includes("npm:some-provider@1.2.3"));
  assert.ok(after.packages.includes("npm:pi-subagents@0.75.0"));
  assert.equal(after.packages.some((p) => p.endsWith(path.basename(ROOT)) && !p.startsWith("npm:")), false);
  assert.equal(fs.existsSync(path.join(env.agentDir, "foreman.json")), true);
  assert.ok(backups(env).length >= 1);
  // a second remove has nothing left to do
  assert.match(run(env, ["--remove"]).out, /up to date/);
});

test("--remove keeps a hand-edited block", () => {
  const env = fresh();
  assert.equal(run(env, []).code, 0);
  const s = readSettings(env);
  s.subagents.agentOverrides.builder.tools = ["read"];
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  assert.equal(run(env, ["--remove"]).code, 0);
  assert.deepEqual(readSettings(env).subagents.agentOverrides.builder.tools, ["read"]);
});

test("Pi outside 1.0.x is refused and nothing is written", () => {
  const env = fresh();
  seed(env);
  const before = snapshot(env.base);
  const r = run(env, [], { FAKE_PI_VERSION: "1.1.0" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /outside the supported range 1\.0\.x/);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(installs(env), []);
});

test("overlay needs an exact version", () => {
  const env = fresh();
  for (const bad of ["npm:@org/overlay", "npm:@org/overlay@^1.0.0", "npm:@org/overlay@latest", "@org/overlay@1.0.0"]) {
    const r = run(env, ["--overlay", bad]);
    assert.notEqual(r.code, 0, bad);
    assert.match(r.out, /exact version/);
  }
  assert.deepEqual(installs(env), []);
  const ok = run(env, ["--overlay", "npm:@org/overlay@1.2.3"]);
  assert.equal(ok.code, 0, ok.out);
  assert.ok(installs(env).some((a) => a[1] === "npm:@org/overlay@1.2.3"));
});

const permFile = (env) => path.join(env.agentDir, "extensions", "pi-permission-system", "config.json");
const permBackups = (env) => fs.readdirSync(path.dirname(permFile(env))).filter((f) => f.startsWith("config.json.bak-"));

test("permission-system config is generated, hashed in managed state, and a second run leaves it alone", () => {
  const env = fresh();
  fs.writeFileSync(path.join(env.agentDir, "foreman.json"), JSON.stringify({ version: 1, providers: {}, safety: { permissions: { deny: ["make nuke*"], projectCommands: ["make check *"] } } }));
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  const cfg = JSON.parse(fs.readFileSync(permFile(env), "utf8"));
  assert.equal(cfg.permission.bash["git status *"], "allow");
  assert.equal(cfg.permission.bash["make check *"], "allow");
  assert.equal(cfg.permission.bash["make nuke*"].action, "deny");
  assert.equal(cfg.permission.path["*.env"].action, "deny");
  assert.ok(cfg.permission.path[`${env.agentDir.split(path.sep).join("/")}/auth.json`]);
  const managed = JSON.parse(fs.readFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), "utf8"));
  assert.match(managed.files[permFile(env)], /^[0-9a-f]{64}$/);
  assert.equal(permBackups(env).length, 0);
  const before = snapshot(env.base);
  const again = run(env, []);
  assert.match(again.out, /permission-system config: in sync/);
  assert.deepEqual(snapshot(env.base), before);
});

test("a hand-edited permission-system config is backed up and overwritten; the notice names foreman.json", () => {
  const env = fresh();
  assert.equal(run(env, []).code, 0);
  const edited = JSON.parse(fs.readFileSync(permFile(env), "utf8"));
  edited.permission.bash = "allow";
  fs.writeFileSync(permFile(env), `${JSON.stringify(edited, null, 2)}\n`);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /edited by hand.*put your own rules in foreman\.json/s);
  assert.equal(permBackups(env).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(permFile(env)), permBackups(env)[0]), "utf8")).permission.bash, "allow");
  assert.equal(JSON.parse(fs.readFileSync(permFile(env), "utf8")).permission.bash["*"], "ask");
});

test("--remove deletes an unchanged permission-system config (with a backup) and keeps an edited one", () => {
  const env = fresh();
  assert.equal(run(env, []).code, 0);
  assert.equal(run(env, ["--remove"]).code, 0);
  assert.equal(fs.existsSync(permFile(env)), false);
  assert.equal(permBackups(env).length, 1);
  const env2 = fresh();
  assert.equal(run(env2, []).code, 0);
  fs.writeFileSync(permFile(env2), '{"permission": {"*": "allow"}}\n');
  assert.equal(run(env2, ["--remove"]).code, 0);
  assert.equal(fs.existsSync(permFile(env2)), true);
});

test("pi-foreman is placed before pi-claude-bridge in packages: dry run shows it, the run backs up and moves it, a rerun is a no-op", () => {
  const env = fresh();
  const seeded = { theme: "dark", packages: ["npm:pi-claude-bridge@0.9.1", "npm:some-provider@1.2.3"] };
  seed(env, seeded);
  const before = snapshot(env.base);
  const dry = run(env, ["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /packages: would move pi-foreman before pi-claude-bridge/);
  assert.match(dry.out, /^-\s+"npm:pi-claude-bridge@0\.9\.1",$/m);
  assert.deepEqual(snapshot(env.base), before, "dry run writes nothing");

  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  const pk = readSettings(env).packages;
  const foreman = pk.findIndex((p) => path.resolve(env.agentDir, p) === ROOT);
  assert.ok(foreman >= 0 && foreman < pk.indexOf("npm:pi-claude-bridge@0.9.1"), JSON.stringify(pk));
  assert.equal(backups(env).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.agentDir, backups(env)[0]), "utf8")), seeded);

  fs.rmSync(env.log);
  const settled = snapshot(env.base);
  const again = run(env, []);
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /move pi-foreman/);
  assert.deepEqual(snapshot(env.base), settled);
  assert.match(again.out, /up to date/);
});
