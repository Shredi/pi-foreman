import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFakePython } from "./fixtures/fake-python.mjs";

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

// Hermetic: setup finds an empty model registry here, never the real global Pi (or `npm root -g`). Discovery tests override it.
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

function run(env, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA, ...extraEnv },
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
  assert.doesNotMatch(r.out, /permission-system config|gate migration/);
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
  assert.deepEqual(readSettings(env).packages, ["npm:@gotgenes/pi-permission-system@39.0.2", "npm:keep-me@1.0.0", FOREMAN]); // setup never drops the package entry itself
  assert.equal(installs(env).filter((a) => a[0] === "remove").length, 3);
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
const migrationDir = (env) => path.join(env.agentDir, "pi-foreman", "state", "migration");

test("a fresh install writes no permission-system config and records no permission hash", () => {
  const env = fresh();
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(permFile(env)), false);
  assert.doesNotMatch(r.out, /permission-system config|gate migration/);
  const managed = JSON.parse(fs.readFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), "utf8"));
  assert.equal(managed.files?.[permFile(env)], undefined);
  const before = snapshot(env.base);
  assert.equal(run(env, []).code, 0);
  assert.deepEqual(snapshot(env.base), before);
});

test("setup migrates old permission keys and the rendered config with backups; a dry run writes nothing and a rerun is a no-op", () => {
  const env = fresh();
  const foreman = path.join(env.agentDir, "foreman.json");
  fs.writeFileSync(foreman, JSON.stringify({ version: 1, providers: {}, safety: { permissions: { deny: ["make nuke*"], autoReview: { rulesFile: "rules.md" } } } }));
  fs.mkdirSync(path.dirname(permFile(env)), { recursive: true });
  fs.writeFileSync(permFile(env), '{"permission": {"*": "ask"}}\n');
  const before = snapshot(env.base);
  const dry = run(env, ["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /gate migration: would write .*foreman\.json\.pre-gate/);
  assert.deepEqual(snapshot(env.base), before);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /safety\.permissions\.autoReview\.rulesFile: moved to gate\.policy\.userFile/);
  assert.match(r.out, /safety\.permissions\.deny: removed/);
  assert.equal(fs.existsSync(permFile(env)), false);
  assert.ok(fs.existsSync(path.join(migrationDir(env), "foreman.json.pre-gate")));
  assert.equal(fs.readFileSync(path.join(migrationDir(env), "permission-system-config.json"), "utf8"), '{"permission": {"*": "ask"}}\n');
  const cfg = JSON.parse(fs.readFileSync(foreman, "utf8"));
  assert.equal(cfg.safety?.permissions, undefined);
  assert.equal(cfg.gate.policy.userFile, "rules.md");
  const again = run(env, []);
  assert.doesNotMatch(again.out, /gate migration/);
});

test("--remove does not migrate or touch the rendered permission config", () => {
  const env = fresh();
  assert.equal(run(env, []).code, 0);
  fs.mkdirSync(path.dirname(permFile(env)), { recursive: true });
  fs.writeFileSync(permFile(env), '{"permission": {"*": "allow"}}\n');
  const r = run(env, ["--remove"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /gate migration|permission-system config/);
  assert.equal(fs.existsSync(permFile(env)), true);
});

test("pi-foreman is placed before pi-claude-bridge in packages: dry run shows it, the run backs up and moves it, a rerun is a no-op", () => {
  const env = fresh();
  const seeded = { theme: "dark", packages: ["npm:pi-claude-bridge@0.9.1", "npm:some-provider@1.2.3", FOREMAN] };
  seed(env, seeded);
  const before = snapshot(env.base);
  const dry = run(env, ["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /packages: would move pi-foreman before pi-claude-bridge/);
  assert.match(dry.out, /^\+\s+"git:github\.com\/Shredi\/pi-foreman",$/m); // the LCS diff shows the move as an insert and a removal
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
  fs.mkdirSync(path.join(checkout, "extensions", "core-adapter"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "extensions", "core-adapter", "profiles.mjs"), path.join(checkout, "extensions", "core-adapter", "profiles.mjs"));
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

// ---- compaction overrides (Pi compaction.modelOverrides derived from the model registry)

const REGISTRY = {
  "openai-completions": {
    "chat:big": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 272000 }] } },
    "chat:mid-a": { contextWindow: 400000, cost: { tiers: [] } },
    "chat:small": { contextWindow: 100000 },
    "chat:other": { contextWindow: 400000 },
    "classifier:mid-cls": { contextWindow: 400000 },
    "image:mid-img": { contextWindow: 400000 },
  },
};

function withRegistry(env, registry = REGISTRY) {
  const dir = path.join(env.base, "pi-ai-data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tp.json"), JSON.stringify(registry));
  return { PI_FOREMAN_PI_AI_DATA: dir };
}

function writeForeman(env, tp = {}, extra = {}) {
  const base = { roles: { builder: { model: "tp/big" } }, ranks: [{ match: "mid-*", tier: 1 }] };
  fs.writeFileSync(path.join(env.agentDir, "foreman.json"), JSON.stringify({ version: 1, providers: { tp: { ...base, ...tp } }, ...extra }));
}

const overrides = (s) => s.compaction?.modelOverrides ?? {};
const managedFile = (env) => path.join(env.agentDir, "pi-foreman", "managed.json");
const managedEntries = (env) => JSON.parse(fs.readFileSync(managedFile(env), "utf8")).entries;
const derivedOf = (env, file = path.join(env.agentDir, "settings.json")) => managedEntries(env)[file]?.compactionDerived;

test("compaction: derives reserveTokens for role-map and ranks models from a nested registry, skipping classifier: and image: entries", () => {
  const env = fresh();
  seed(env);
  writeForeman(env);
  const reg = withRegistry(env);
  const r = run(env, [], reg);
  assert.equal(r.code, 0, r.out);
  const s = readSettings(env);
  assert.deepEqual(overrides(s), { "tp/big": { reserveTokens: 800000 }, "tp/mid-a": { reserveTokens: 200000 } });
  assert.deepEqual(derivedOf(env), { "tp/big": 800000, "tp/mid-a": 200000 });
  assert.match(Object.values(managedEntries(env))[0].subagentsHash, /^[0-9a-f]{64}$/);
  assert.match(r.out, /compaction tp\/big: reserveTokens unset -> 800000/);
  assert.match(r.out, /^\+\s+"reserveTokens": 800000/m);
  assert.equal(backups(env).length, 1);
  assert.equal(s.theme, "dark");
  // a second run changes nothing
  const settled = snapshot(env.base);
  const again = run(env, [], reg);
  assert.match(again.out, /up to date/);
  assert.deepEqual(snapshot(env.base), settled);
});

test("compaction: the lowest price tier (minus 20000) wins when the cap is off", () => {
  const env = fresh();
  seed(env);
  writeForeman(env, {}, { compaction: { maxTokens: null } });
  const r = run(env, [], withRegistry(env));
  assert.equal(r.code, 0, r.out);
  assert.equal(overrides(readSettings(env))["tp/big"].reserveTokens, 1000000 - (272000 - 20000));
});

test("compaction: nothing is written when Pi already compacts at the derived point", () => {
  const env = fresh();
  seed(env);
  writeForeman(env, { roles: { builder: { model: "tp/small" } }, ranks: [] });
  const r = run(env, [], withRegistry(env));
  assert.equal(r.code, 0, r.out);
  assert.equal(readSettings(env).compaction, undefined);
  assert.equal(derivedOf(env), undefined);
});

test("compaction: a point below keepRecentTokens + 20000 warns naming the model and writes nothing", () => {
  const env = fresh();
  seed(env);
  writeForeman(env, { roles: { builder: { model: "tp/tiny" } }, ranks: [] });
  const reg = withRegistry(env, { api: { "chat:tiny": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 55000 }] } } } });
  const r = run(env, [], reg);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warning: compaction: tp\/tiny: the point 35000 is below keepRecentTokens \+ 20000/);
  assert.equal(readSettings(env).compaction, undefined);
});

test("compaction: a user value is kept and not recorded; enabled, global reserveTokens and keepRecentTokens are never touched", () => {
  const env = fresh();
  const mine = { enabled: false, reserveTokens: 20000, keepRecentTokens: 30000, modelOverrides: { "tp/big": { reserveTokens: 500000, keepRecentTokens: 25000 }, "other/x": { reserveTokens: 1 } } };
  seed(env, { ...SEED, compaction: mine });
  writeForeman(env);
  const reg = withRegistry(env);
  const r = run(env, [], reg);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compaction tp\/big: reserveTokens 500000, kept: user value/);
  const c = readSettings(env).compaction;
  assert.deepEqual(c.modelOverrides["tp/big"], { reserveTokens: 500000, keepRecentTokens: 25000 });
  assert.equal(c.enabled, false);
  assert.equal(c.reserveTokens, 20000);
  assert.equal(c.keepRecentTokens, 30000);
  assert.deepEqual(c.modelOverrides["other/x"], { reserveTokens: 1 });
  assert.deepEqual(derivedOf(env), { "tp/mid-a": 200000 });
  // --remove: only the recorded entry goes
  const rm = run(env, ["--remove"], reg);
  assert.equal(rm.code, 0, rm.out);
  const after = readSettings(env).compaction;
  assert.deepEqual(after, { ...mine, modelOverrides: { "tp/big": mine.modelOverrides["tp/big"], "other/x": { reserveTokens: 1 } } });
});

test("compaction: an own earlier value is updated, a stale one removed, an edited one kept", () => {
  const env = fresh();
  seed(env);
  writeForeman(env);
  const reg = withRegistry(env);
  assert.equal(run(env, [], reg).code, 0);
  // lower cap: own values are updated
  writeForeman(env, {}, { compaction: { maxTokens: 150000 } });
  const up = run(env, [], reg);
  assert.equal(up.code, 0, up.out);
  assert.deepEqual(derivedOf(env), { "tp/big": 850000, "tp/mid-a": 250000 });
  assert.equal(overrides(readSettings(env))["tp/big"].reserveTokens, 850000);
  // the user edits one value; the ranks glob goes away: the edited value stays, the other one is removed
  const s = readSettings(env);
  s.compaction.modelOverrides["tp/mid-a"].reserveTokens = 123456;
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  writeForeman(env, { ranks: [] }, { compaction: { maxTokens: 150000 } });
  const stale = run(env, [], reg);
  assert.equal(stale.code, 0, stale.out);
  assert.deepEqual(overrides(readSettings(env)), { "tp/big": { reserveTokens: 850000 }, "tp/mid-a": { reserveTokens: 123456 } });
  assert.deepEqual(derivedOf(env), { "tp/big": 850000 });
  // the role goes away too: the last own value is removed and the empty containers with it
  writeForeman(env, { roles: {}, ranks: [] }, { compaction: { maxTokens: 150000 } });
  assert.equal(run(env, [], reg).code, 0);
  assert.deepEqual(overrides(readSettings(env)), { "tp/mid-a": { reserveTokens: 123456 } });
  assert.equal(derivedOf(env), undefined);
});

test("compaction: --remove deletes recorded entries and the record, and counts as something to remove", () => {
  const env = fresh();
  seed(env);
  writeForeman(env);
  const reg = withRegistry(env);
  assert.equal(run(env, [], reg).code, 0);
  // drop the subagents block from the record so only the compaction entries are left to remove
  const s = readSettings(env);
  delete s.subagents;
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  const rm = run(env, ["--remove"], reg);
  assert.equal(rm.code, 0, rm.out);
  assert.doesNotMatch(rm.out, /nothing to remove/);
  assert.equal(readSettings(env).compaction, undefined);
  assert.equal(managedEntries(env)[path.join(env.agentDir, "settings.json")], undefined);
  assert.match(run(env, ["--remove"], reg).out, /nothing to remove/);
});

test("compaction: --dry-run writes nothing but shows the diff", () => {
  const env = fresh();
  seed(env);
  writeForeman(env);
  const reg = withRegistry(env);
  const before = snapshot(env.base);
  const r = run(env, ["--dry-run"], reg);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compaction tp\/big: reserveTokens unset -> 800000/);
  assert.match(r.out, /^\+\s+"reserveTokens": 800000/m);
  assert.deepEqual(snapshot(env.base), before);
});

test("compaction: --project writes the project file with its own record; the global entry survives; a user global per-model override wins", () => {
  const env = fresh();
  seed(env);
  writeForeman(env);
  const reg = withRegistry(env);
  assert.equal(run(env, [], reg).code, 0);
  const globalFile = path.join(env.agentDir, "settings.json");
  const projFile = path.join(env.cwd, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(projFile));
  fs.writeFileSync(projFile, `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  const p = run(env, ["--project"], reg);
  assert.equal(p.code, 0, p.out);
  const proj = JSON.parse(fs.readFileSync(projFile, "utf8"));
  assert.deepEqual(overrides(proj), { "tp/big": { reserveTokens: 800000 }, "tp/mid-a": { reserveTokens: 200000 } });
  const entries = managedEntries(env);
  assert.deepEqual(entries[projFile].compactionDerived, { "tp/big": 800000, "tp/mid-a": 200000 });
  assert.match(entries[projFile].subagentsHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(entries[globalFile].compactionDerived, { "tp/big": 800000, "tp/mid-a": 200000 });
  assert.match(entries[globalFile].subagentsHash, /^[0-9a-f]{64}$/);
  // a user's own earlier-compacting per-model value in the global file means the project run writes nothing for that model
  const env2 = fresh();
  seed(env2, { ...SEED, compaction: { modelOverrides: { "tp/big": { reserveTokens: 950000 } } } });
  writeForeman(env2, { ranks: [] });
  const reg2 = withRegistry(env2);
  const proj2 = path.join(env2.cwd, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(proj2));
  fs.writeFileSync(proj2, `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  const q = run(env2, ["--project"], reg2);
  assert.equal(q.code, 0, q.out);
  assert.equal(JSON.parse(fs.readFileSync(proj2, "utf8")).compaction, undefined);
  assert.equal(readSettings(env2).compaction.modelOverrides["tp/big"].reserveTokens, 950000);
});

test("compaction: a global run never writes the project layer's cap", () => {
  const env = fresh();
  seed(env);
  writeForeman(env, { ranks: [] });
  fs.mkdirSync(path.join(env.cwd, ".pi"));
  fs.writeFileSync(path.join(env.cwd, ".pi", "foreman.json"), JSON.stringify({ version: 1, compaction: { maxTokens: 60000 } }));
  const r = run(env, [], withRegistry(env));
  assert.equal(r.code, 0, r.out);
  assert.equal(overrides(readSettings(env))["tp/big"].reserveTokens, 800000);
});

test("compaction: models an overlay declares under providers.<p>.models are covered, with their tiers", () => {
  const env = fresh();
  seed(env);
  writeForeman(env, { roles: { builder: { model: "tp/ghost" } }, ranks: [], models: { ghost: { contextWindow: 500000, tiers: [{ inputTokensAbove: 300000 }] } } }, { compaction: { maxTokens: null } });
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(overrides(readSettings(env)), { "tp/ghost": { reserveTokens: 500000 - 280000 } });
  assert.doesNotMatch(r.out, /registry unavailable/);
});

test("compaction: discovery finds the package when the first pi on PATH is a plain file, and in the hoisted layout", { skip: process.platform === "win32" }, () => {
  const env = fresh();
  seed(env);
  writeForeman(env);
  const pkg = path.join(env.base, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "bin", "pi.js"), "\n");
  const data = path.join(pkg, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "tp.json"), JSON.stringify(REGISTRY));
  const plain = path.join(env.base, "bin1");
  const linked = path.join(env.base, "bin2");
  fs.mkdirSync(plain);
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(plain, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.symlinkSync(path.join(pkg, "bin", "pi.js"), path.join(linked, "pi"));
  const r = run(env, [], { PI_FOREMAN_PI_AI_DATA: "", PATH: [plain, linked, process.env.PATH].join(path.delimiter) });
  assert.equal(r.code, 0, r.out);
  assert.equal(overrides(readSettings(env))["tp/big"].reserveTokens, 800000);

  // hoisted: pi-ai sits next to pi-coding-agent under the same node_modules; PI_FOREMAN_PI_BIN points into the package
  const env2 = fresh();
  seed(env2);
  writeForeman(env2);
  const nm = path.join(env2.base, "hoist", "node_modules", "@earendil-works");
  fs.mkdirSync(path.join(nm, "pi-coding-agent"), { recursive: true });
  const hdata = path.join(nm, "pi-ai", "dist", "providers", "data");
  fs.mkdirSync(hdata, { recursive: true });
  fs.writeFileSync(path.join(hdata, "tp.json"), JSON.stringify(REGISTRY));
  const cli = path.join(nm, "pi-coding-agent", "cli.js");
  fs.copyFileSync(FAKE_PI, cli);
  const r2 = run(env2, [], { PI_FOREMAN_PI_AI_DATA: "", PI_FOREMAN_PI_BIN: cli });
  assert.equal(r2.code, 0, r2.out);
  assert.equal(overrides(readSettings(env2))["tp/big"].reserveTokens, 800000);
});

test("compaction: a missing or unreadable registry is one warning, nothing is written for it, and own entries stay", () => {
  const env = fresh();
  seed(env);
  writeForeman(env, { roles: { builder: { model: "tp/big" }, reviewer: { model: "tp/other" } } });
  const reg = withRegistry(env);
  assert.equal(run(env, [], reg).code, 0);
  const kept = readSettings(env).compaction;
  assert.ok(kept.modelOverrides["tp/big"]);
  const gone = run(env, [], { PI_FOREMAN_PI_AI_DATA: path.join(env.base, "no-such-dir") });
  assert.equal(gone.code, 0, gone.out);
  assert.equal(gone.out.match(/Pi model registry unavailable/g).length, 1, gone.out);
  assert.deepEqual(readSettings(env).compaction, kept);
  fs.writeFileSync(path.join(env.base, "pi-ai-data", "tp.json"), "{ not json");
  const bad = run(env, [], reg);
  assert.equal(bad.code, 0, bad.out);
  assert.equal(bad.out.match(/Pi model registry unavailable/g).length, 1, bad.out);
  assert.deepEqual(readSettings(env).compaction, kept);
});

// ---- compaction overrides for providers Pi has no registry file for (live model list, modelDataFrom)

const ANTHROPIC = {
  api: {
    "chat:claude-opus-5-5": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 272000 }] } },
    "chat:claude-sonnet-5-5": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 272000 }] } },
    "chat:claude-sonnet-4-9": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 272000 }] } },
    "chat:claude-fable-5-1": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 272000 }] } },
    "chat:claude-haiku-5-5": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 100000 }] } },
  },
};

function dataDir(env, files) {
  const dir = path.join(env.base, "pi-ai-data");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, reg] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(reg));
  return { PI_FOREMAN_PI_AI_DATA: dir };
}

/** Env for run(): the fake `pi --list-models` prints a table of [provider, id, context] rows (or `raw` text), exit `code`. */
function listing(env, rows, { code = 0, raw } = {}) {
  const file = path.join(env.base, "list-models.json");
  const header = "provider  model  context  max-out  thinking  images\n";
  const output = raw ?? header + rows.map(([p, id, ctx]) => `${p}  ${id}  ${ctx}  8K  yes  no`).join("\n") + "\n";
  fs.writeFileSync(file, JSON.stringify({ output, code }));
  return { FAKE_PI_LIST_MODELS: file };
}

const writeCfg = (env, cfg) => fs.writeFileSync(path.join(env.agentDir, "foreman.json"), JSON.stringify({ version: 1, ...cfg }));
const listCalls = (env) => calls(env).filter((a) => a[0] === "--list-models");
const linesFor = (out, key) => out.split("\n").filter((l) => l.includes(`${key}:`) && /compaction/.test(l));
const CAP150 = { compaction: { maxTokens: 150000 } };

test("compaction: a role map on a bridge provider (model, strong, idle, review, security rung) gets keys from the live window and the base tiers", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, {
    ...CAP150,
    ladder: { reviewerClimb: { enabled: true, securityRung: "claude-bridge/claude-sonnet-4-9:high" } },
    providers: {
      "claude-bridge": {
        roles: {
          builder: { model: "claude-bridge/claude-sonnet-5-5:medium", strong: { model: "claude-bridge/claude-opus-5-5" } },
          foreman: { model: "claude-bridge/claude-opus-5-5", idle: { model: "claude-bridge/claude-haiku-5-5" } },
        },
        review: { model: "claude-bridge/claude-fable-5-1" },
      },
    },
  });
  const ids = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-sonnet-4-9"];
  const r = run(env, [], { ...dataDir(env, { anthropic: ANTHROPIC }), ...listing(env, ids.map((id) => ["claude-bridge", id, "200K"])) });
  assert.equal(r.code, 0, r.out);
  const o = overrides(readSettings(env));
  assert.deepEqual(Object.keys(o).sort(), ids.map((id) => `claude-bridge/${id}`).sort());
  for (const id of ids) assert.equal(o[`claude-bridge/${id}`].reserveTokens, id === "claude-haiku-5-5" ? 120000 : 50000, id);
  assert.equal(listCalls(env).length, 1);
  assert.doesNotMatch(r.out, /no price tiers known/);
});

test("compaction: a borrowed window is the live one, not the base's; a Haiku-shaped bridge model at 200K gets reserve 120000", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, { ...CAP150, providers: { "claude-bridge": { roles: { builder: { model: "claude-bridge/claude-sonnet-5-5" }, reviewer: { model: "claude-bridge/claude-haiku-5-5" } } } } });
  const reg = dataDir(env, { anthropic: ANTHROPIC });
  const r = run(env, [], { ...reg, ...listing(env, [["claude-bridge", "claude-sonnet-5-5", "200K"], ["claude-bridge", "claude-haiku-5-5", "200K"]]) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(overrides(readSettings(env)), { "claude-bridge/claude-haiku-5-5": { reserveTokens: 120000 }, "claude-bridge/claude-sonnet-5-5": { reserveTokens: 50000 } });
  assert.match(r.out, /compaction claude-bridge\/claude-haiku-5-5: reserveTokens unset -> 120000 \(compacts at 80000\)/);
  assert.deepEqual(derivedOf(env), { "claude-bridge/claude-haiku-5-5": 120000, "claude-bridge/claude-sonnet-5-5": 50000 });
  // the same model at a 1M live window gets the 1M reserve
  const env2 = fresh();
  seed(env2);
  writeCfg(env2, { ...CAP150, providers: { "claude-bridge": { roles: { builder: { model: "claude-bridge/claude-sonnet-5-5" } } } } });
  assert.equal(run(env2, [], { ...dataDir(env2, { anthropic: ANTHROPIC }), ...listing(env2, [["claude-bridge", "claude-sonnet-5-5", "1M"]]) }).code, 0);
  assert.equal(overrides(readSettings(env2))["claude-bridge/claude-sonnet-5-5"].reserveTokens, 850000);
});

test("compaction: ranks on a provider without a registry file match live-listed models of that provider only", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, { ...CAP150, providers: { "claude-bridge": { ranks: [{ match: "claude-opus-*", tier: 1 }] } } });
  const rows = [["claude-bridge", "claude-opus-5-5", "200K"], ["claude-bridge", "claude-sonnet-5-5", "200K"], ["anthropic", "claude-opus-5-5", "1M"], ["other", "claude-opus-9", "200K"]];
  const r = run(env, [], { ...dataDir(env, { anthropic: ANTHROPIC }), ...listing(env, rows) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(overrides(readSettings(env)), { "claude-bridge/claude-opus-5-5": { reserveTokens: 50000 } });
  assert.equal(listCalls(env).length, 1);
});

test("compaction: config modelDataFrom overrides the built-in base and serves a custom bridge; a project-layer value is ignored", () => {
  const env = fresh();
  seed(env);
  const other = { api: { "chat:claude-opus-5-5": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 120000 }] } } } };
  writeCfg(env, {
    providers: {
      "claude-bridge": { modelDataFrom: "other", roles: { builder: { model: "claude-bridge/claude-opus-5-5" } } },
      "my-bridge": { modelDataFrom: "anthropic", roles: { reviewer: { model: "my-bridge/claude-opus-5-5" } } },
    },
  });
  const reg = dataDir(env, { anthropic: ANTHROPIC, other });
  const l = listing(env, [["claude-bridge", "claude-opus-5-5", "1M"], ["my-bridge", "claude-opus-5-5", "1M"]]);
  const r = run(env, [], { ...reg, ...l });
  assert.equal(r.code, 0, r.out);
  // other: tier 120000 -> point 100000; anthropic: tier 272000 -> the 200000 cap
  assert.deepEqual(overrides(readSettings(env)), { "claude-bridge/claude-opus-5-5": { reserveTokens: 900000 }, "my-bridge/claude-opus-5-5": { reserveTokens: 800000 } });
  // a global run never reads the project layer
  const env2 = fresh();
  seed(env2);
  writeCfg(env2, { providers: { "claude-bridge": { roles: { builder: { model: "claude-bridge/claude-opus-5-5" } } } } });
  fs.mkdirSync(path.join(env2.cwd, ".pi"));
  fs.writeFileSync(path.join(env2.cwd, ".pi", "foreman.json"), JSON.stringify({ version: 1, providers: { "claude-bridge": { modelDataFrom: "other" } } }));
  const reg2 = dataDir(env2, { anthropic: ANTHROPIC, other });
  const l2 = listing(env2, [["claude-bridge", "claude-opus-5-5", "1M"]]);
  assert.equal(run(env2, [], { ...reg2, ...l2 }).code, 0);
  assert.equal(overrides(readSettings(env2))["claude-bridge/claude-opus-5-5"].reserveTokens, 800000);
  // --project honours only the user and overlay layers for it
  const proj = path.join(env2.cwd, ".pi", "settings.json");
  fs.writeFileSync(proj, `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  const p = run(env2, ["--project"], { ...reg2, ...l2 });
  assert.equal(p.code, 0, p.out);
  assert.equal(overrides(JSON.parse(fs.readFileSync(proj, "utf8")))["claude-bridge/claude-opus-5-5"].reserveTokens, 800000);
});

test("compaction: every skip has its own line and writes nothing", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, {
    providers: { "claude-bridge": { roles: { builder: { model: "claude-bridge/claude-unknown-9" }, reviewer: { model: "claude-bridge/claude-opus-5-5" } } } },
  });
  const reg = dataDir(env, { anthropic: ANTHROPIC });
  const r = run(env, [], { ...reg, ...listing(env, [["claude-bridge", "claude-unknown-9", "200K"]]) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compaction claude-bridge\/claude-unknown-9: skipped, no model data; declare providers\.claude-bridge\.models\.claude-unknown-9 or providers\.claude-bridge\.modelDataFrom$/m);
  assert.match(r.out, /compaction claude-bridge\/claude-opus-5-5: skipped, not in Pi's model list \(provider not logged in, its extension not loaded, or the project untrusted\); log in and re-run setup$/m);
  assert.equal(readSettings(env).compaction, undefined);
  // a failed listing: one warning, one skip line per live-dependent key
  for (const l of [{}, listing(env, [], { code: 3 })]) {
    const f = run(env, [], { ...reg, ...l });
    assert.equal(f.code, 0, f.out);
    assert.equal(f.out.match(/warning: compaction: Pi's model list unavailable \(exit \d\); keys that need it skipped/g).length, 1, f.out);
    assert.equal(f.out.match(/: skipped, Pi's model list unavailable$/gm).length, 2, f.out);
    assert.equal(readSettings(env).compaction, undefined);
  }
});

test("compaction: a Haiku-shaped registry entry (window 1000000, tier 100000) compacts at 80000 with reserve 920000, without a listing", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, { providers: { anthropic: { roles: { reviewer: { model: "anthropic/claude-haiku-5-5" } } } } });
  const r = run(env, [], dataDir(env, { anthropic: ANTHROPIC }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compaction anthropic\/claude-haiku-5-5: reserveTokens unset -> 920000 \(compacts at 80000\)/);
  assert.equal(overrides(readSettings(env))["anthropic/claude-haiku-5-5"].reserveTokens, 920000);
  assert.deepEqual(listCalls(env), []);
});

test("compaction: Pi's default model is covered, joined as provider/model; --project merges the two fields", () => {
  const env = fresh();
  seed(env, { ...SEED, defaultProvider: "tp", defaultModel: "big" });
  writeForeman(env, { roles: {}, ranks: [] });
  assert.equal(run(env, [], withRegistry(env)).code, 0);
  assert.deepEqual(overrides(readSettings(env)), { "tp/big": { reserveTokens: 800000 } });
  // a model id with a slash is not split
  const env2 = fresh();
  seed(env2, { ...SEED, defaultProvider: "gw", defaultModel: "vendor/model" });
  writeCfg(env2, { providers: { gw: { models: { "vendor/model": { contextWindow: 1000000, tiers: [{ inputTokensAbove: 272000 }] } } } } });
  const r2 = run(env2, []);
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(overrides(readSettings(env2)), { "gw/vendor/model": { reserveTokens: 800000 } });
  // --project: provider from the global file, model from the project file; a project value wins per field
  const env3 = fresh();
  seed(env3, { ...SEED, defaultProvider: "tp", defaultModel: "mid-a" });
  writeForeman(env3, { roles: {}, ranks: [] });
  const proj = path.join(env3.cwd, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(proj));
  fs.writeFileSync(proj, `${JSON.stringify({ packages: [FOREMAN], defaultModel: "big" })}\n`);
  const p = run(env3, ["--project"], withRegistry(env3));
  assert.equal(p.code, 0, p.out);
  assert.deepEqual(overrides(JSON.parse(fs.readFileSync(proj, "utf8"))), { "tp/big": { reserveTokens: 800000 } });
});

test("compaction: --remove after a bridge run deletes only entries still equal to the record", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, { ...CAP150, providers: { "claude-bridge": { ranks: [{ match: "claude-*", tier: 1 }] } } });
  const run1 = { ...dataDir(env, { anthropic: ANTHROPIC }), ...listing(env, [["claude-bridge", "claude-opus-5-5", "200K"], ["claude-bridge", "claude-sonnet-5-5", "200K"]]) };
  assert.equal(run(env, [], run1).code, 0);
  const s = readSettings(env);
  s.compaction.modelOverrides["claude-bridge/claude-sonnet-5-5"].reserveTokens = 77777;
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  const rm = run(env, ["--remove"], run1);
  assert.equal(rm.code, 0, rm.out);
  assert.deepEqual(overrides(readSettings(env)), { "claude-bridge/claude-sonnet-5-5": { reserveTokens: 77777 } });
  assert.equal(listCalls(env).length, 1);
});

test("compaction: --dry-run prints exactly one line per key for every branch and writes nothing", () => {
  const env = fresh();
  seed(env, { ...SEED, compaction: { modelOverrides: { "tp/kept": { reserveTokens: 500000 } } } });
  const wide = (ids) => Object.fromEntries(ids.map((id) => [`chat:${id}`, { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 272000 }] } }]));
  writeCfg(env, {
    providers: {
      tp: {
        roles: {
          builder: { model: "tp/a", strong: { model: "tp/gone" } },
          reviewer: { model: "tp/rm", strong: { model: "tp/bm" } },
          planner: { model: "tp/kept" },
        },
      },
    },
  });
  assert.equal(run(env, [], dataDir(env, { tp: { api: wide(["a", "gone", "rm", "bm", "kept"]) } })).code, 0);
  assert.deepEqual(derivedOf(env), { "tp/a": 800000, "tp/gone": 800000, "tp/rm": 800000, "tp/bm": 800000 });
  const s = readSettings(env);
  delete s.compaction.modelOverrides["tp/gone"];
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  writeCfg(env, {
    providers: {
      tp: {
        roles: {
          builder: { model: "tp/a", strong: { model: "tp/new" } },
          reviewer: { model: "tp/bm", strong: { model: "tp/kept" } },
          planner: { model: "tp/small", strong: { model: "tp/missing" } },
        },
      },
    },
  });
  const reg = dataDir(env, {
    tp: { api: { ...wide(["a", "new", "kept"]), "chat:bm": { contextWindow: 1000000, cost: { tiers: [{ inputTokensAbove: 55000 }] } }, "chat:small": { contextWindow: 100000 } } },
  });
  const before = snapshot(env.base);
  const r = run(env, ["--dry-run"], reg);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(snapshot(env.base), before);
  const want = {
    "tp/a": /reserveTokens 800000, unchanged \(compacts at 200000\)/,
    "tp/new": /reserveTokens unset -> 800000 \(compacts at 200000\)/,
    "tp/small": /no override needed \(Pi already compacts at 83616\)/,
    "tp/kept": /reserveTokens 500000, kept: user value/,
    "tp/gone": /recorded override already gone/,
    "tp/rm": /reserveTokens 800000 no longer needed, removing/,
    "tp/bm": /the point 35000 is below keepRecentTokens \+ 20000; no override written; removing the earlier override/,
    "tp/missing": /skipped, no model data; declare providers\.tp\.models\.missing$/,
  };
  for (const [key, re] of Object.entries(want)) {
    const ls = linesFor(r.out, key);
    assert.equal(ls.length, 1, `${key}: ${JSON.stringify(ls)}\n${r.out}`);
    assert.match(ls[0], re, key);
  }
});

function bridgeRecorded() {
  const env = fresh();
  seed(env);
  const cfg = (bridge, tp) => writeCfg(env, { ...CAP150, providers: { "claude-bridge": bridge, tp: tp } });
  cfg({ ranks: [{ match: "claude-*", tier: 1 }] }, { roles: { builder: { model: "tp/big" } } });
  const reg = dataDir(env, { anthropic: ANTHROPIC, tp: REGISTRY });
  const first = run(env, [], { ...reg, ...listing(env, [["claude-bridge", "claude-opus-5-5", "200K"]]) });
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(derivedOf(env), { "claude-bridge/claude-opus-5-5": 50000, "tp/big": 850000 });
  cfg({}, {});
  return { env, reg };
}

test("compaction: recorded bridge entries stay while the live list fails or lacks the provider; a registry provider's stale entry is still removed", () => {
  const failed = bridgeRecorded();
  const a = run(failed.env, [], { ...failed.reg, ...listing(failed.env, [], { code: 1 }) });
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /compaction claude-bridge\/claude-opus-5-5: recorded reserveTokens 50000 kept \(Pi's model list unavailable\)/);
  assert.deepEqual(overrides(readSettings(failed.env)), { "claude-bridge/claude-opus-5-5": { reserveTokens: 50000 } });
  assert.deepEqual(derivedOf(failed.env), { "claude-bridge/claude-opus-5-5": 50000 });
  const absent = bridgeRecorded();
  const b = run(absent.env, [], { ...absent.reg, ...listing(absent.env, [["other", "x", "200K"]]) });
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /compaction claude-bridge\/claude-opus-5-5: recorded reserveTokens 50000 kept \(claude-bridge is not in Pi's model list\)/);
  assert.match(b.out, /compaction tp\/big: reserveTokens 850000 no longer needed, removing/);
  assert.deepEqual(overrides(readSettings(absent.env)), { "claude-bridge/claude-opus-5-5": { reserveTokens: 50000 } });
  // with the provider listed but the model gone, the record is judged and removed
  const gone = bridgeRecorded();
  assert.equal(run(gone.env, [], { ...gone.reg, ...listing(gone.env, [["claude-bridge", "claude-haiku-5-5", "200K"]]) }).code, 0);
  assert.equal(overrides(readSettings(gone.env))["claude-bridge/claude-opus-5-5"], undefined);
});

test("compaction: a registry provider's unknown id has one exact line and spawns no listing; declared keys never spawn; a registry failure skips bridge keys", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, { providers: { tp: { roles: { builder: { model: "tp/nope" } } } } });
  const reg = withRegistry(env);
  const r = run(env, [], reg);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(linesFor(r.out, "tp/nope"), ["compaction tp/nope: skipped, no model data; declare providers.tp.models.nope"]);
  writeCfg(env, { providers: { tp: { modelDataFrom: "anthropic", roles: { builder: { model: "tp/nope" } } } } });
  const again = run(env, [], { ...reg, ...dataDir(env, { anthropic: ANTHROPIC, tp: REGISTRY }) });
  assert.deepEqual(linesFor(again.out, "tp/nope"), ["compaction tp/nope: skipped, no model data; declare providers.tp.models.nope"]);
  assert.deepEqual(listCalls(env), []);
  // a registry failure: one warning, no listing, no line for the bridge keys, the declared key still judged
  const env2 = fresh();
  seed(env2);
  writeCfg(env2, {
    compaction: { maxTokens: null },
    providers: {
      "claude-bridge": { roles: { builder: { model: "claude-bridge/claude-opus-5-5" } } },
      tp: { models: { ghost: { contextWindow: 500000, tiers: [{ inputTokensAbove: 300000 }] } } },
    },
  });
  const f = run(env2, [], { PI_FOREMAN_PI_AI_DATA: path.join(env2.base, "no-such-dir"), ...listing(env2, [["claude-bridge", "claude-opus-5-5", "200K"]]) });
  assert.equal(f.code, 0, f.out);
  assert.equal(f.out.match(/Pi model registry unavailable/g).length, 1, f.out);
  assert.deepEqual(listCalls(env2), []);
  assert.deepEqual(linesFor(f.out, "claude-bridge/claude-opus-5-5").filter((l) => !l.includes("registry unavailable")), []);
  assert.deepEqual(linesFor(f.out, "tp/ghost"), ["compaction tp/ghost: reserveTokens unset -> 220000 (compacts at 280000)"]);
});

test("compaction: a declared key on a provider without a registry file spawns no listing while the registry works", () => {
  const env = fresh();
  seed(env, { ...SEED, defaultProvider: "gw", defaultModel: "vendor/model" });
  writeCfg(env, { providers: { gw: { models: { "vendor/model": { contextWindow: 1000000, tiers: [{ inputTokensAbove: 272000 }] } } } } });
  const r = run(env, [], { ...withRegistry(env), ...listing(env, []) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(linesFor(r.out, "gw/vendor/model"), ["compaction gw/vendor/model: reserveTokens unset -> 800000 (compacts at 200000)"]);
  assert.deepEqual(overrides(readSettings(env)), { "gw/vendor/model": { reserveTokens: 800000 } });
  assert.deepEqual(listCalls(env), []);
});

test("compaction: the listing's context cell is read like Pi's formatTokenCount", () => {
  const env = fresh();
  seed(env);
  writeCfg(env, { ...CAP150, providers: { xb: { roles: { builder: { model: "xb/k-tenths", strong: { model: "xb/k-top" } }, reviewer: { model: "xb/m-int" }, planner: { model: "xb/bare", strong: { model: "xb/k-small" } } } } } });
  const rows = [["xb", "k-tenths", "262.1K"], ["xb", "k-small", "1.4K"], ["xb", "k-top", "1000.0K"], ["xb", "bare", "512"], ["xb", "m-int", "1M"]];
  const r = run(env, [], listing(env, rows));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compaction xb\/k-tenths: reserveTokens unset -> 112150 \(compacts at 150000\) \(no price tiers known\)/);
  assert.match(r.out, /compaction xb\/k-top: reserveTokens unset -> 849999 \(compacts at 150000\)/);
  assert.match(r.out, /compaction xb\/m-int: reserveTokens unset -> 850000 \(compacts at 150000\)/);
  assert.match(r.out, /compaction xb\/k-small: no override needed \(Pi already compacts at -14934\)/);
  assert.match(r.out, /compaction xb\/bare: no override needed \(Pi already compacts at -15872\)/);
  // 1.0M matches a base window that formats identically (1048576), else it is skipped
  const env2 = fresh();
  seed(env2);
  writeCfg(env2, { compaction: { maxTokens: null }, providers: { "claude-bridge": { roles: { builder: { model: "claude-bridge/claude-opus-5-5", strong: { model: "claude-bridge/claude-sonnet-5-5" } } } } } });
  const exact = { api: { "chat:claude-opus-5-5": { contextWindow: 1048576, cost: { tiers: [{ inputTokensAbove: 272000 }] } }, "chat:claude-sonnet-5-5": { contextWindow: 1000000, cost: { tiers: [] } } } };
  const m = run(env2, [], { ...dataDir(env2, { anthropic: exact }), ...listing(env2, [["claude-bridge", "claude-opus-5-5", "1.0M"], ["claude-bridge", "claude-sonnet-5-5", "1.0M"]]) });
  assert.equal(m.code, 0, m.out);
  assert.match(m.out, /compaction claude-bridge\/claude-opus-5-5: reserveTokens unset -> 796576 \(compacts at 252000\)/);
  assert.match(m.out, /compaction claude-bridge\/claude-sonnet-5-5: skipped, window 1\.0M is not exact; declare providers\.claude-bridge\.models\.claude-sonnet-5-5$/m);
  // the no-models message (exit 0, no header) is a failed listing
  const env3 = fresh();
  seed(env3);
  writeCfg(env3, { providers: { xb: { roles: { builder: { model: "xb/some" } } } } });
  const n = run(env3, [], listing(env3, [], { raw: "No models available. Set an API key or log in.\n" }));
  assert.equal(n.code, 0, n.out);
  assert.match(n.out, /warning: compaction: Pi's model list unavailable \(no model list printed\); keys that need it skipped/);
  assert.match(n.out, /compaction xb\/some: skipped, Pi's model list unavailable$/m);
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
  fs.mkdirSync(path.join(root, "extensions", "core-adapter"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "extensions", "core-adapter", "profiles.mjs"), path.join(root, "extensions", "core-adapter", "profiles.mjs"));
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

test("setup refuses a python3 3.12 on PATH with the 3.13 message", posix, () => {
  const env = fresh();
  seed(env);
  const fake = path.join(env.base, "fake");
  fs.mkdirSync(fake);
  writeFakePython(path.join(fake, "python3"), "3.12", `${env.base}-python.log`);
  const r = spawnSync(process.execPath, [SETUP, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { PATH: fake, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /No Python >= 3\.13 found \(tried: .*python3.*Python 3\.12 is older than 3\.13/);
  assert.deepEqual(installs(env), []);
});

test("setup accepts a 3.13 interpreter named by PI_FOREMAN_PYTHON, with no python3 on PATH", posix, () => {
  const env = fresh();
  seed(env);
  const empty = path.join(env.base, "empty");
  fs.mkdirSync(empty);
  const py = writeFakePython(path.join(env.base, "py313"), "3.13", `${env.base}-python.log`);
  const r = spawnSync(process.execPath, [SETUP, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { PATH: empty, PI_FOREMAN_PYTHON: py, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /python 3\.13 via PI_FOREMAN_PYTHON/);
  assert.doesNotMatch(out, /No Python/);
  assert.ok(fs.readFileSync(`${env.base}-python.log`, "utf8").includes("sys.executable"));
});

// ---------------------------------------------------------------- profiles, features and add-ons

const foremanJson = (env) => JSON.parse(fs.readFileSync(path.join(env.agentDir, "foreman.json"), "utf8"));
const foremanBackups = (env) => fs.readdirSync(env.agentDir).filter((f) => f.startsWith("foreman.json.bak-"));
const writeUser = (env, cfg) => fs.writeFileSync(path.join(env.agentDir, "foreman.json"), `${JSON.stringify({ version: 1, providers: {}, ...cfg }, null, 2)}\n`);
const NO_PICKER = { PI_FOREMAN_PICKER: undefined };
const HINT = "features: no profile chosen yet; run foreman setup --pick in a terminal, or pass --profile <name> [--enable/--disable <id>]";

test("profile flags: every exit-2 combination names the rule and writes nothing", () => {
  const env = fresh();
  seed(env);
  const before = snapshot(env.base);
  const cases = [
    [["--profile", "nope"], /unknown profile nope; valid: orchestration, standard, full/],
    [["--enable", "nope"], /unknown feature id nope; toggleable: codemode/],
    [["--disable", "codemode,nope"], /unknown feature id nope/],
    [["--enable", "setup"], /setup is not toggleable.*docs\/features\.md/],
    [["--enable", "codemode", "--disable", "codemode"], /codemode is in both enable and disable/],
    [["--addon", "nope"], /unknown add-on nope; valid: polish, background-tasks/],
    [["--pick", "--profile", "standard"], /--pick cannot be combined with --profile/],
    [["--pick", "--enable", "codemode"], /--pick cannot be combined with --enable/],
    [["--pick", "--addon", "polish"], /--pick cannot be combined with --addon/],
    [["--pick"], /--pick needs a terminal/],
    [["--remove", "--profile", "standard"], /--profile cannot be combined with --remove/],
    [["--remove", "--enable", "codemode"], /--enable cannot be combined with --remove/],
    [["--remove", "--disable", "codemode"], /--disable cannot be combined with --remove/],
    [["--remove", "--addon", "polish"], /--addon cannot be combined with --remove/],
    [["--remove", "--pick"], /--pick cannot be combined with --remove/],
  ];
  for (const [args, re] of cases) {
    const r = run(env, args, NO_PICKER);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, re, args.join(" "));
  }
  const off = run(env, ["--pick"], { PI_FOREMAN_PICKER: "off" });
  assert.equal(off.code, 2, off.out);
  assert.match(off.out, /PI_FOREMAN_PICKER=off/);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(calls(env), []);
});

test("--profile orchestration writes toggles, profile key, backup and diff; the generated block reflects it in the same run; a second run is a no-op", () => {
  const plain = fresh();
  seed(plain);
  assert.equal(run(plain, [], NO_PICKER).code, 0);
  const env = fresh();
  seed(env);
  const mine = { fanout: { max: 2 }, providers: { tp: { roles: { builder: { model: "tp/big" } } } } };
  writeUser(env, mine);
  const r = run(env, ["--profile", "orchestration"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  const cfg = foremanJson(env);
  assert.equal(cfg.profile, "orchestration");
  assert.equal(cfg.tools.pr, false);
  assert.equal(cfg.herdr.blockedShim, false);
  assert.equal(cfg.herdr.groupTag, false);
  assert.equal(cfg.footer.usage, false);
  assert.equal(cfg.ladder.idleDownshift.enabled, false);
  assert.equal(cfg.retro.enabled, false);
  assert.equal(cfg.trace.enabled, false);
  assert.equal(cfg.providers.tp.cache.keepalive.enabled, false);
  assert.equal(cfg.roles, undefined, "features in their shipped state write nothing");
  assert.deepEqual(cfg.fanout, { max: 2 });
  assert.equal(foremanBackups(env).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.agentDir, foremanBackups(env)[0]), "utf8")), { version: 1, ...mine });
  assert.match(r.out, /^--- a\/foreman\.json/m);
  assert.match(r.out, /^\+\+\+ b\/foreman\.json/m);
  assert.match(r.out, /feature pr-ops -> off \(tools\.pr=false\)/);
  assert.doesNotMatch(r.out, /WARN safety relaxations/);
  assert.doesNotMatch(r.out, new RegExp(HINT.replace(/[[\]<>/]/g, ".")));
  // same run: the pr tools are gone from the generated block
  const reviewer = (e) => readSettings(e).subagents.agentOverrides.reviewer.tools;
  assert.ok(reviewer(plain).includes("pr_status"));
  assert.ok(!reviewer(env).includes("pr_status"));
  assert.deepEqual(pythonValidate(env).data.errors, []);
  // second run changes nothing
  const before = snapshot(env.base);
  fs.rmSync(env.log);
  const again = run(env, ["--profile", "orchestration"], NO_PICKER);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /foreman\.json: up to date \(profile orchestration\)/);
  assert.match(again.out, /pi-foreman: up to date, nothing to change/);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(installs(env), []);
});

test("--enable and --disable after a profile win over it and keep the recorded profile", () => {
  const env = fresh();
  seed(env);
  assert.equal(run(env, ["--profile", "orchestration"], NO_PICKER).code, 0);
  assert.equal(foremanJson(env).tools.pr, false);
  const r = run(env, ["--enable", "pr-ops,herdr", "--disable", "codemode"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  const cfg = foremanJson(env);
  assert.equal(cfg.tools.pr, true);
  assert.equal(cfg.herdr.blockedShim, true);
  assert.equal(cfg.roles.foreman.codemode, false);
  assert.equal(cfg.footer.usage, false);
  assert.equal(cfg.profile, "orchestration");
  assert.equal(foremanBackups(env).length, 1);
  // repeatable flags give the same result
  const env2 = fresh();
  seed(env2);
  assert.equal(run(env2, ["--profile", "orchestration"], NO_PICKER).code, 0);
  assert.equal(run(env2, ["--enable", "pr-ops", "--enable", "herdr", "--disable", "codemode"], NO_PICKER).code, 0);
  assert.deepEqual(foremanJson(env2), cfg);
});

test("--profile full warns about the safety relaxations; --profile standard afterwards turns them back off", () => {
  const env = fresh();
  seed(env);
  const full = run(env, ["--profile", "full"], NO_PICKER);
  assert.equal(full.code, 0, full.out);
  assert.match(full.out, /WARN safety relaxations on: git-tools, children-may-push, workflow-scripts, remote-intercom/);
  let cfg = foremanJson(env);
  assert.equal(cfg.tools.git, true);
  assert.equal(cfg.safety.children.mayPush, true);
  assert.equal(cfg.safety.subagents.allowWorkflow, true);
  assert.equal(cfg.intercom.allowRemote, true);
  assert.deepEqual(pythonValidate(env).data.errors, []);
  const std = run(env, ["--profile", "standard"], NO_PICKER);
  assert.equal(std.code, 0, std.out);
  assert.doesNotMatch(std.out, /WARN safety relaxations/);
  cfg = foremanJson(env);
  assert.equal(cfg.profile, "standard");
  assert.equal(cfg.tools.git, false);
  assert.equal(cfg.safety.children.mayPush, false);
  assert.equal(cfg.safety.subagents.allowWorkflow, false);
  assert.equal(cfg.intercom.allowRemote, false);
  assert.equal(cfg.ladder.reviewerClimb.enabled, false);
});

test("a non-interactive run prints the no-profile hint and never prompts, even with PI_FOREMAN_PICKER=off", () => {
  const env = fresh();
  seed(env);
  const r = run(env, [], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(HINT), r.out);
  assert.doesNotMatch(r.out, /Profiles:|Adjust features/);
  assert.deepEqual(foremanJson(env), { version: 1, providers: {} });
  const off = run(env, [], { PI_FOREMAN_PICKER: "off" });
  assert.ok(off.out.includes(HINT));
  assert.doesNotMatch(off.out, /Profiles:/);
  // a recorded profile silences the hint
  assert.equal(run(env, ["--profile", "standard"], NO_PICKER).code, 0);
  assert.ok(!run(env, [], NO_PICKER).out.includes(HINT));
});

test("a recorded unknown profile warns and skips the picker", () => {
  const env = fresh();
  seed(env);
  writeUser(env, { profile: "bogus" });
  const r = run(env, [], { PI_FOREMAN_PICKER: "force", CI: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN profile bogus unknown \(valid: orchestration, standard, full\).*--profile/);
  assert.doesNotMatch(r.out, /Profiles:|nothing written/);
  assert.ok(!r.out.includes(HINT));
  assert.equal(foremanJson(env).profile, "bogus");
});

test("--addon background-tasks runs the exact pi install, records managed.addons and prints the shell-profile env hint", () => {
  const env = fresh();
  seed(env);
  const r = run(env, ["--addon", "background-tasks"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(installs(env), [["install", "npm:pi-background-tasks@2.6.10"]]);
  assert.match(r.out, /PI_BG_FEATURES=process permanently in your shell profile; Pi reads it when it starts/);
  const s = readSettings(env);
  assert.ok(s.packages.includes("npm:pi-background-tasks@2.6.10"));
  assert.ok(s.subagents.agentOverrides, "the settings write kept the generated block next to the new package");
  const managed = JSON.parse(fs.readFileSync(managedFile(env), "utf8"));
  assert.equal(managed.addons["background-tasks"].spec, "npm:pi-background-tasks@2.6.10");
  assert.match(managed.addons["background-tasks"].installedAt, /^\d{4}-\d\d-\d\dT/);
  assert.doesNotMatch(r.out, /optional add-on background-tasks/);
  // installed now: a second consent installs nothing
  fs.rmSync(env.log);
  const again = run(env, ["--addon", "background-tasks"], NO_PICKER);
  assert.match(again.out, /add-on background-tasks: already installed \(npm:pi-background-tasks@2\.6\.10\), no command/);
  assert.deepEqual(installs(env), []);
});

test("without --addon nothing is installed; the hint lines name the add-ons", () => {
  const env = fresh();
  seed(env);
  const r = run(env, [], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(installs(env), []);
  assert.match(r.out, /optional add-on polish: .*npm:pi-polish@0\.1\.2.*foreman setup --addon polish/);
  assert.match(r.out, /optional add-on background-tasks: .*npm:pi-background-tasks@2\.6\.10.*PI_BG_FEATURES=process.*foreman setup --addon background-tasks/);
  assert.doesNotMatch(r.out, /pi install npm:pi-background-tasks\)/);
});

test("--project --addon installs nothing when the add-on is installed globally", () => {
  const env = fresh();
  seed(env, { packages: [FOREMAN, "npm:pi-background-tasks@2.5.0"] });
  const projFile = path.join(env.cwd, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(projFile));
  fs.writeFileSync(projFile, `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  const r = run(env, ["--project", "--addon", "background-tasks"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /add-on background-tasks: already installed \(npm:pi-background-tasks@2\.5\.0\), no command/);
  assert.deepEqual(installs(env), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(projFile, "utf8")).packages, [FOREMAN]);
  // not installed anywhere: the project run installs with -l
  const env2 = fresh();
  const projFile2 = path.join(env2.cwd, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(projFile2));
  fs.writeFileSync(projFile2, `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  assert.equal(run(env2, ["--project", "--addon", "polish"], NO_PICKER).code, 0);
  assert.deepEqual(installs(env2), [["install", "npm:pi-polish@0.1.2", "-l"]]);
});

test("--remove lists installed add-ons with their pi remove lines and removes none", () => {
  const env = fresh();
  seed(env, { packages: [FOREMAN, "npm:pi-polish@0.1.2"] });
  const r = run(env, ["--remove"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes("add-ons installed: polish (npm:pi-polish@0.1.2); kept, remove with: pi remove npm:pi-polish@0.1.2"), r.out);
  assert.deepEqual(installs(env), []);
  assert.ok(readSettings(env).packages.includes("npm:pi-polish@0.1.2"));
});

test("--dry-run with a profile and an add-on writes nothing and runs nothing", () => {
  const env = fresh();
  seed(env);
  writeUser(env, {});
  const before = snapshot(env.base);
  const r = run(env, ["--dry-run", "--profile", "orchestration", "--addon", "polish"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(calls(env).filter((a) => a[0] !== "--version"), []);
  assert.match(r.out, /foreman\.json: would write changes/);
  assert.match(r.out, /^\+\+\+ b\/foreman\.json/m);
  assert.match(r.out, /would run: pi install npm:pi-polish@0\.1\.2/);
  // an absent foreman.json is not created either
  const env2 = fresh();
  seed(env2);
  const before2 = snapshot(env2.base);
  assert.equal(run(env2, ["--dry-run", "--profile", "full"], NO_PICKER).code, 0);
  assert.deepEqual(snapshot(env2.base), before2);
});

test("a pre-existing validation error does not block a profile change", () => {
  const env = fresh();
  seed(env);
  writeUser(env, { displayNames: "nope" });
  assert.ok(pythonValidate(env).data.errors.length > 0);
  const r = run(env, ["--profile", "orchestration"], NO_PICKER);
  assert.equal(r.code, 0, r.out);
  assert.equal(foremanJson(env).profile, "orchestration");
  assert.equal(foremanJson(env).displayNames, "nope");
});

test("a new validation error writes nothing and exits 1", posix, () => {
  const env = fresh();
  seed(env);
  writeUser(env, {});
  // answers the version probe itself; reports an extra error for any validation of a candidate file (--user-file)
  const py = path.join(env.base, "pywrap");
  fs.writeFileSync(
    py,
    `#!/bin/sh
case "$*" in *sys.executable*) echo 3.13; echo "$0"; exit 0;; esac
case "$*" in *"validate --json"*"--user-file"*) echo '{"config":{},"warnings":[],"errors":["injected: new problem"]}'; exit 1;; esac
exec python3 "$@"
`,
    { mode: 0o755 },
  );
  const before = snapshot(env.base);
  const r = run(env, ["--profile", "orchestration"], { ...NO_PICKER, PI_FOREMAN_PYTHON: py });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /foreman\.json error: injected: new problem/);
  assert.match(r.out, /nothing was written/);
  assert.deepEqual(snapshot(env.base), before);
  assert.deepEqual(installs(env), []);
});
