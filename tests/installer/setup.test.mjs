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

const FOREMAN = "git:github.com/Shredi/pi-foreman";

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-installer-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
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
const SEED = { theme: "dark", packages: ["npm:some-provider@1.2.3", FOREMAN], defaultModel: "x/y", zeta: 1, alpha: 2 };

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
  assert.doesNotMatch(r.out, /would run: pi (install|remove)/);
  assert.match(r.out, /package pi-subagents@0\.78\.0: bundled with pi-foreman/);
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
  assert.ok(s.packages.includes(FOREMAN));
  const managed = JSON.parse(fs.readFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), "utf8"));
  assert.match(Object.values(managed.entries)[0].subagentsHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(installs(env), []);
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

const intercomCfg = (env) => path.join(env.agentDir, "intercom", "config.json");

test("--no-intercom filters pi-intercom on the pi-foreman entry (dry run shows it), skips its config, and is idempotent", () => {
  const env = fresh();
  seed(env);
  const dry = run(env, ["--dry-run", "--no-intercom"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would filter pi-intercom out of the pi-foreman entry/);
  assert.match(dry.out, /^\+\s+"!node_modules\/pi-intercom\/\*\*"/m);
  assert.equal(readSettings(env).packages[1], FOREMAN);
  const r = run(env, ["--no-intercom"]);
  assert.equal(r.code, 0, r.out);
  const entry = readSettings(env).packages[1];
  assert.deepEqual(entry, { source: FOREMAN, extensions: ["!node_modules/pi-intercom/**"], skills: ["!node_modules/pi-intercom/**"] });
  assert.equal(fs.existsSync(intercomCfg(env)), false);
  const settled = snapshot(env.base);
  const again = run(env, ["--no-intercom"]);
  assert.match(again.out, /up to date/);
  assert.deepEqual(snapshot(env.base), settled);
  assert.match(run(env, ["--help"]).out, /--no-intercom/);
});

test("leftover top-level bundled packages and a legacy local pi-foreman entry are removed via pi remove; dry run shows it and writes nothing", () => {
  const env = fresh();
  const legacy = path.join(env.base, "old-checkout");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "package.json"), '{"name": "pi-foreman"}\n');
  seed(env, { packages: ["npm:pi-subagents@0.75.0", "npm:@gotgenes/pi-permission-system@39.0.2", "npm:pi-intercom@0.16.1", legacy, "npm:keep-me@1.0.0", FOREMAN] });
  const before = snapshot(env.base);
  const dry = run(env, ["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would run: pi remove npm:pi-subagents@0\.75\.0/);
  assert.match(dry.out, /would run: pi remove npm:pi-intercom@0\.16\.1/);
  assert.ok(dry.out.includes(`would run: pi remove ${legacy}`), dry.out);
  assert.deepEqual(snapshot(env.base), before);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readSettings(env).packages, ["npm:keep-me@1.0.0", FOREMAN]);
  assert.equal(installs(env).filter((a) => a[0] === "remove").length, 4);
});

test("without a pi-foreman package entry setup prints the install line and fails", () => {
  const env = fresh();
  seed(env, { packages: ["npm:some-provider@1.2.3"] });
  const before = snapshot(env.base);
  const r = run(env, []);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /^pi install git:github\.com\/Shredi\/pi-foreman$/m);
  assert.deepEqual(snapshot(env.base), before);
});

test("pi-foreman package entries are recognised in git, https and npm forms", () => {
  for (const form of ["git:github.com/someone/pi-foreman@v1.2.0", "github.com/someone/pi-foreman", "https://github.com/someone/pi-foreman", "npm:pi-foreman@1.0.0", "git:gitlab.com/o/pi-foreman", "git:git.example.com/o/pi-foreman@v1", "https://git.example.com/o/pi-foreman.git"]) {
    const env = fresh();
    seed(env, { packages: ["npm:pi-claude-bridge@0.9.2", form] });
    const r = run(env, ["--dry-run"]);
    assert.equal(r.code, 0, `${form}: ${r.out}`);
    assert.match(r.out, /would move pi-foreman before pi-claude-bridge/, form);
  }
});

test("lookalike package entries are not recognised as pi-foreman", () => {
  for (const form of ["git:github.com/o/pi-foreman-extras", "git:example.com/o/other"]) {
    const env = fresh();
    seed(env, { packages: ["npm:pi-claude-bridge@0.9.2", form] });
    const r = run(env, ["--dry-run"]);
    assert.notEqual(r.code, 0, form);
  }
});

test("the bridge login hint is printed when pi-claude-bridge is a package", () => {
  const env = fresh();
  assert.doesNotMatch(run(env, ["--dry-run"]).out, /log in once/);
  seed(env, { packages: [FOREMAN, "npm:pi-claude-bridge@0.9.2"] });
  assert.match(run(env, ["--dry-run"]).out, /pi-claude-bridge: log in once.*claude-config claude/);
});

test("intercom config is written once (dry run shows it), never overwritten; trusted overrides warn", () => {
  const env = fresh();
  seed(env);
  const dry = run(env, ["--dry-run"]);
  assert.match(dry.out, /intercom config: absent, would create/);
  assert.match(dry.out, /\+\s+"busyDelivery": "human-first"/);
  assert.equal(fs.existsSync(intercomCfg(env)), false);
  assert.equal(run(env, []).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(intercomCfg(env), "utf8")), { inboundTrigger: "always", busyDelivery: "human-first" });
  const own = { inboundTrigger: "replies", brokerCommand: "bun", crossMachine: { machineName: "m" } };
  fs.writeFileSync(intercomCfg(env), JSON.stringify(own));
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(intercomCfg(env), "utf8")), own);
  assert.match(r.out, /intercom config: present, left alone/);
  assert.match(r.out, /warning: .*sets brokerCommand, crossMachine/);
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
  assert.ok(after.packages.includes(FOREMAN));
  assert.deepEqual(installs(env), []);
  assert.ok(r.out.includes(`to remove it run: pi remove ${FOREMAN}`), r.out);
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

test("Pi outside 1.4.x is refused and nothing is written", () => {
  const env = fresh();
  seed(env);
  const before = snapshot(env.base);
  const r = run(env, [], { FAKE_PI_VERSION: "1.2.0" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /outside the supported range 1\.4\.x/);
  assert.match(r.out, /pi-coding-agent@1\.4\.0 \(pinned\)/);
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
  const seeded = { theme: "dark", packages: ["npm:pi-claude-bridge@0.9.1", "npm:some-provider@1.2.3", FOREMAN] };
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
  const foreman = pk.indexOf(FOREMAN);
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

test("--develop writes <checkout>/.pi/settings.json (override of the installed package), merges, and is idempotent", () => {
  const env = fresh();
  const checkout = path.join(env.base, "checkout");
  fs.mkdirSync(checkout);
  for (const f of ["setup.mjs", "packages.lock.json", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(checkout, f));
  fs.cpSync(path.join(ROOT, "scripts"), path.join(checkout, "scripts"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(checkout, "config"), { recursive: true });
  const file = path.join(checkout, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ theme: "light", packages: [FOREMAN, "npm:keep-me@1.0.0"] }));
  const go = (args) => {
    const r = spawnSync(process.execPath, [path.join(checkout, "setup.mjs"), ...args, "--agent-dir", env.agentDir], {
      cwd: env.cwd, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const dry = go(["--develop", "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /develop: would write/);
  assert.match(dry.out, /pi -a/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).packages.length, 2);
  const r = go(["--develop"]);
  assert.equal(r.code, 0, r.out);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.theme, "light");
  assert.deepEqual(written.packages, ["..", { source: FOREMAN, extensions: [], skills: [], prompts: [], themes: [] }, "npm:keep-me@1.0.0"]);
  const text = fs.readFileSync(file, "utf8");
  assert.match(go(["--develop"]).out, /already loads this checkout/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  const proj = spawnSync(process.execPath, [path.join(checkout, "setup.mjs"), "--project", "--dry-run", "--agent-dir", env.agentDir], {
    cwd: checkout, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log },
  });
  assert.doesNotMatch(`${proj.stdout}${proj.stderr}`, /package \.\.: would remove/, "the override does not make \"..\" stale");
});

test("packages.lock.json bundled pins equal the package.json dependencies", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "packages.lock.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const bundled = Object.fromEntries(lock.packages.filter((p) => p.mode === "bundled").map((p) => [p.name, p.version]));
  assert.deepEqual(bundled, pkg.dependencies);
});

const hookConfig = (env) => path.join(env.agentDir, "extensions", "subagent", "config.json");
const posix = { skip: process.platform === "win32" };

test("setup registers the pi-subagents worktree setup hook when unset, keeps a hand-set one", posix, () => {
  const env = fresh();
  seed(env);
  const dry = run(env, ["--dry-run"]);
  assert.match(dry.out, /worktree setup hook: would write worktreeSetupHook=/);
  assert.equal(fs.existsSync(hookConfig(env)), false);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  const launcher = path.join(ROOT, "bin", "foreman-worktree-setup");
  assert.match(r.out, new RegExp(`worktreeSetupHookTimeoutMs=600000 to ${hookConfig(env).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(hookConfig(env), "utf8")), { worktreeSetupHook: launcher, worktreeSetupHookTimeoutMs: 600000 });
  assert.ok(fs.existsSync(launcher));
  assert.match(run(env, []).out, /up to date/);
  // a hook somebody else set is left alone
  fs.writeFileSync(hookConfig(env), `${JSON.stringify({ worktreeSetupHook: "/opt/own-hook.sh", other: 1 })}\n`);
  const r2 = run(env, []);
  assert.match(r2.out, /already set to \/opt\/own-hook\.sh, left alone/);
  assert.deepEqual(JSON.parse(fs.readFileSync(hookConfig(env), "utf8")), { worktreeSetupHook: "/opt/own-hook.sh", other: 1 });
  // a stale path of our own launcher is repaired
  fs.writeFileSync(hookConfig(env), `${JSON.stringify({ worktreeSetupHook: "/gone/bin/foreman-worktree-setup", worktreeSetupHookTimeoutMs: 5000 })}\n`);
  run(env, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(hookConfig(env), "utf8")), { worktreeSetupHook: launcher, worktreeSetupHookTimeoutMs: 5000 });
});

test("setup keeps the top-level bundled copies when a manifest entry does not resolve under the package root", posix, () => {
  const env = fresh();
  const root = path.join(env.base, "pkg");
  fs.mkdirSync(root);
  for (const f of ["setup.mjs", "package.json", "packages.lock.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  for (const d of ["scripts", "config", "core", "agents"]) fs.symlinkSync(path.join(ROOT, d), path.join(root, d));
  seed(env, { packages: ["npm:pi-subagents@0.75.0", "npm:keep-me@1.0.0", FOREMAN] });
  const r = spawnSync(process.execPath, [path.join(root, "setup.mjs"), "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /missing bundled entries under .*pkg: run npm ci in the checkout/);
  assert.deepEqual(installs(env), []);
  assert.deepEqual(readSettings(env).packages, ["npm:pi-subagents@0.75.0", "npm:keep-me@1.0.0", FOREMAN]);
});
