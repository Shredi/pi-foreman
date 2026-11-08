import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const { envTarget, mergeBlock, renderBlock, persistEnv, BLOCK_START, BLOCK_END } = await import(pathToFileURL(path.join(ROOT, "setup", "persist-env.mjs")).href);

const DEFAULTS = ["polish", "background-tasks", "quiver", "memory"];

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-addons-default-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  for (const d of [agentDir, cwd, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  return { base, agentDir, cwd, home, log: `${base}-calls.jsonl` };
}

// No add-on flag is injected here: this file is about what a plain run does. HOME stays the sandbox's; no real profile or registry is touched.
function run(env, args, extra = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    input: "",
    env: {
      ...process.env, CI: "1", PI_FOREMAN_PICKER: "off", PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log,
      PI_FOREMAN_PI_AI_DATA: path.join(env.base, "no-models"), PI_FOREMAN_HOME: env.home, SHELL: "/bin/zsh", PI_BG_FEATURES: undefined, ...extra,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const installs = (env) => {
  try {
    return fs.readFileSync(env.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args).filter((a) => a[0] === "install").map((a) => a[1]);
  } catch {
    return [];
  }
};
const managed = (env) => JSON.parse(fs.readFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), "utf8"));
const specs = DEFAULTS.map((id) => ({ polish: "npm:pi-polish@0.1.2", "background-tasks": "npm:pi-background-tasks@2.6.10", quiver: "npm:pi-quiver@6.14.2", memory: "npm:pi-memory@0.4.2" })[id]);

test("a plain non-interactive run installs the default add-ons, says so, and records them as offered", () => {
  const env = fresh();
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(installs(env), specs);
  assert.match(r.out, /installing the default add-ons: polish, background-tasks, quiver, memory/);
  const m = managed(env);
  assert.deepEqual(Object.keys(m.addons), DEFAULTS);
  assert.deepEqual(m.addonsOffered, DEFAULTS);
  // a second run finds them installed and offers nothing
  fs.rmSync(env.log);
  const again = run(env, []);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(installs(env), []);
  assert.doesNotMatch(again.out, /newly default/);
});

test("--no-addons installs none, --skip-addon leaves one out, --addon names exactly the set", () => {
  const none = fresh();
  assert.equal(run(none, ["--no-addons"]).code, 0);
  assert.deepEqual(installs(none), []);
  const skip = fresh();
  assert.equal(run(skip, ["--skip-addon", "memory,quiver"]).code, 0);
  assert.deepEqual(installs(skip), specs.slice(0, 2));
  const only = fresh();
  assert.equal(run(only, ["--addon", "polish"]).code, 0);
  assert.deepEqual(installs(only), [specs[0]]);
});

test("add-on flag conflicts and unknown ids exit 2 and run nothing", () => {
  const env = fresh();
  for (const [args, re] of [
    [["--skip-addon", "nope"], /unknown add-on nope in --skip-addon; valid: polish, background-tasks, quiver, memory/],
    [["--addon", "polish", "--no-addons"], /cannot be combined with --no-addons or --skip-addon/],
    [["--no-addons", "--skip-addon", "polish"], /--no-addons already skips every add-on/],
  ]) {
    const r = run(env, args);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, re);
  }
  assert.deepEqual(installs(env), []);
});

test("a re-run without addonsOffered installs the newly default add-ons once, never reinstalls an installed one", () => {
  const env = fresh();
  fs.writeFileSync(path.join(env.agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN, "npm:pi-polish@0.1.0"] })}\n`);
  fs.mkdirSync(path.join(env.agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), `${JSON.stringify({ addons: { polish: { spec: "npm:pi-polish@0.1.0", installedAt: "2026-01-01T00:00:00.000Z" } } })}\n`);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /installing newly default add-ons: background-tasks, quiver, memory/);
  assert.deepEqual(installs(env), specs.slice(1));
  assert.deepEqual(managed(env).addonsOffered, DEFAULTS.slice(1));
  fs.rmSync(env.log);
  assert.equal(run(env, []).code, 0);
  assert.deepEqual(installs(env), []);
});

test("--dry-run prints the add-on installs and the env block target and writes nothing", () => {
  const env = fresh();
  const before = fs.readdirSync(env.base).sort();
  const r = run(env, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  for (const s of specs) assert.ok(r.out.includes(`would run: pi install ${s}`), s);
  assert.match(r.out, /would write the pi-foreman block to .*\.zshrc/);
  assert.deepEqual(installs(env), []);
  assert.equal(fs.existsSync(path.join(env.home, ".zshrc")), false);
  assert.deepEqual(fs.readdirSync(env.base).sort(), before);
});

test("background-tasks writes PI_BG_FEATURES=process once into the shell profile; --no-env and a custom agent dir without PI_FOREMAN_HOME leave it alone", () => {
  const env = fresh();
  fs.writeFileSync(path.join(env.home, ".zshrc"), "alias x=y\n");
  assert.equal(run(env, ["--addon", "background-tasks"]).code, 0);
  const text = fs.readFileSync(path.join(env.home, ".zshrc"), "utf8");
  assert.ok(text.startsWith("alias x=y\n"));
  assert.equal(text.split(BLOCK_START).length, 2);
  assert.match(text, /export PI_BG_FEATURES='process'/);
  // unchanged block is not rewritten on re-run
  assert.equal(run(env, ["--addon", "background-tasks"], { PI_BG_FEATURES: "process" }).code, 0);
  assert.equal(fs.readFileSync(path.join(env.home, ".zshrc"), "utf8"), text);
  const off = fresh();
  const r = run(off, ["--addon", "background-tasks", "--no-env"]);
  assert.match(r.out, /not written \(--no-env\)/);
  assert.equal(fs.existsSync(path.join(off.home, ".zshrc")), false);
  const sandboxed = fresh();
  const s = run(sandboxed, ["--addon", "background-tasks"], { PI_FOREMAN_HOME: undefined, HOME: sandboxed.home, USERPROFILE: sandboxed.home });
  assert.match(s.out, /custom agent dir, your shell profile is left alone/);
  assert.equal(fs.existsSync(path.join(sandboxed.home, ".zshrc")), false);
});

test("on Windows the variable goes through the injected setx runner", () => {
  const env = fresh();
  const setx = path.join(env.base, "setx.mjs");
  fs.writeFileSync(setx, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(path.join(env.base, "setx.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  const r = run(env, ["--addon", "background-tasks"], { PI_FOREMAN_PLATFORM: "win32", PI_FOREMAN_SETX_BIN: setx });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fs.readFileSync(path.join(env.base, "setx.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), [["PI_BG_FEATURES", "process"]]);
  assert.equal(fs.existsSync(path.join(env.home, ".zshrc")), false);
});

test("envTarget picks the profile by shell and platform; mergeBlock replaces in place and is idempotent", () => {
  const home = path.join(path.sep, "h");
  assert.equal(envTarget({ platform: "linux", home, shell: "/usr/bin/zsh" }).file, path.join(home, ".zshrc"));
  assert.equal(envTarget({ platform: "linux", home, shell: "/bin/bash" }).file, path.join(home, ".bashrc"));
  assert.equal(envTarget({ platform: "darwin", home, shell: "/bin/bash" }).file, path.join(home, ".bash_profile"));
  const fish = envTarget({ platform: "linux", home, shell: "/usr/bin/fish" });
  assert.equal(fish.file, path.join(home, ".config", "fish", "conf.d", "pi-foreman.fish"));
  assert.equal(fish.fish, true);
  assert.equal(envTarget({ platform: "linux", home, shell: "" }).file, path.join(home, ".profile"));
  assert.equal(envTarget({ platform: "win32", home, shell: "" }).kind, "setx");
  const block = renderBlock({ A: "1" }, false);
  const once = mergeBlock("keep\n", block);
  assert.equal(mergeBlock(once, block), once);
  assert.equal(mergeBlock(once, renderBlock({ A: "2" }, false)), `keep\n\n${BLOCK_START}\nexport A='2'\n${BLOCK_END}\n`);
  assert.equal(renderBlock({ A: "1" }, true), `${BLOCK_START}\nset -gx A '1'\n${BLOCK_END}`);
});

test("persistEnv reports a failing setx and an unwritable profile as WARN without throwing", () => {
  const win = persistEnv({ A: "1" }, { platform: "win32", home: "/x", setx: () => ({ status: 1, error: "boom" }) });
  assert.match(win[0], /^WARN env A: setx failed \(boom\); set it yourself: setx A 1/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-persist-"));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "");
  const posix = persistEnv({ A: "1" }, { platform: "linux", home: blocker, shell: "/bin/zsh" });
  assert.match(posix[0], /^WARN env: could not write/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--skip-addon is remembered: a later plain run installs nothing new", () => {
  const env = fresh();
  assert.equal(run(env, ["--skip-addon", "memory"]).code, 0);
  assert.deepEqual(installs(env), specs.slice(0, 3));
  fs.rmSync(env.log);
  const again = run(env, []);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(installs(env), []);
  assert.deepEqual(managed(env).addonsOffered, DEFAULTS);
});

test("--no-addons is remembered: a later --profile run installs nothing", () => {
  const env = fresh();
  assert.equal(run(env, ["--no-addons"]).code, 0);
  assert.deepEqual(managed(env).addonsOffered, DEFAULTS);
  const again = run(env, ["--profile", "standard"]);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(installs(env), []);
});

test("an existing install without addonsOffered gets the newly-default wording", () => {
  const env = fresh();
  fs.mkdirSync(path.join(env.agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(env.agentDir, "pi-foreman", "managed.json"), `${JSON.stringify({ version: 1, entries: {} })}\n`);
  const r = run(env, []);
  assert.match(r.out, /installing newly default add-ons:/);
});

test("mergeBlock with an orphan start marker keeps the user's lines", () => {
  const text = `${BLOCK_START}\nmine\n`;
  const once = mergeBlock(text, renderBlock({ A: "1" }, false));
  assert.ok(once.startsWith(text));
  const twice = mergeBlock(once, renderBlock({ A: "2" }, false));
  assert.ok(twice.startsWith(text), twice);
  assert.match(twice, /export A='2'/);
});
