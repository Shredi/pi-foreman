// Ledger items 1 to 3 and 5: the installed herdr-app mods against the package (profiles.mjs), `foreman setup --mods`, and the setup offer.
// Every test sets HERDR_APP_HOME to a temp dir; nothing touches the real app home and herdr-app is never run.
import { test, after } from "node:test";
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
const PKG = path.join(ROOT, "integrations", "herdr-app");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const { appHome, diffMods, modsDoctorLines, refreshMods, sourceFiles } = await import(pathToFileURL(path.join(ROOT, "extensions", "core-adapter", "profiles.mjs")).href);

const bases = [];
after(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

/** A fresh sandbox: an app home (not created yet), an agent dir with foreman installed, and a project dir. */
function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-herdr-mods-")));
  bases.push(base);
  const home = path.join(base, "app-home");
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  return { base, home, agentDir, cwd, log: path.join(base, "calls.jsonl") };
}

/** Installs one mod the way the app docs say (a folder copy); test files are left out, as a first install would leave them. */
function installMod(home, mod) {
  fs.cpSync(path.join(PKG, mod), path.join(home, "mods", mod), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
}

/** Every file under a directory, relative with forward slashes, with its bytes. */
function snapshot(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join("/")] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const modDir = (env, mod) => path.join(env.home, "mods", mod);
const envFor = (env, extra = {}) => ({
  ...process.env, CI: undefined, PI_CODING_AGENT_DIR: env.agentDir, HERDR_APP_HOME: env.home, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log,
  PI_FOREMAN_PI_AI_DATA: path.join(env.base, "no-models"), PI_FOREMAN_HOME: env.base, SHELL: "/bin/zsh", PI_FOREMAN_PLATFORM: "linux", PI_BG_FEATURES: undefined, ...extra,
});

/** A setup.mjs run. `input` is what the piped stdin holds (empty = EOF); the picker is off unless a test asks for it. */
function setup(env, args, { input = "", picker = "off" } = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], { cwd: env.cwd, encoding: "utf8", input, env: envFor(env, { PI_FOREMAN_PICKER: picker }) });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------- the module

test("the diff names a differing file and a file the installed copy lacks, per installed mod", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  installMod(env.home, "pi-foreman-plan");
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: env.home }), []);
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  fs.rmSync(path.join(modDir(env, "pi-foreman"), "stubs.mjs"));
  const changed = diffMods({ packageRoot: ROOT, appHome: env.home });
  assert.deepEqual(changed, [{ mod: "pi-foreman", files: ["model.js", "stubs.mjs"] }]);
  assert.deepEqual(modsDoctorLines({ packageRoot: ROOT, appHome: env.home }), [
    "WARN herdr-app mod pi-foreman differs from the package: model.js, stubs.mjs — fix: foreman setup --mods",
  ]);
});

test("the source list leaves out test files, .gitignore, the herdr-app check files and a top-level cache", () => {
  const files = sourceFiles(path.join(PKG, "pi-foreman-plan"));
  assert.ok(files.includes("main.js") && files.includes("model.js") && files.includes("mod.json"));
  assert.equal(files.filter((f) => f.endsWith(".test.mjs")).length, 0);
  for (const skipped of [".gitignore", "gpui-kit.d.ts", "jsconfig.json"]) assert.ok(!files.includes(skipped), skipped);
  assert.ok(!files.some((f) => f.startsWith("cache/")));
});

test("an installed mod in step gives no lines, and a refresh changes nothing", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  installMod(env.home, "pi-foreman-plan");
  const before = snapshot(env.home);
  assert.deepEqual(modsDoctorLines({ packageRoot: ROOT, appHome: env.home }), []);
  assert.deepEqual(refreshMods({ packageRoot: ROOT, appHome: env.home }), []);
  assert.deepEqual(snapshot(env.home), before);
});

test("a mod that is not installed is neither reported nor created by a refresh", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const changed = refreshMods({ packageRoot: ROOT, appHome: env.home });
  assert.deepEqual(changed.map((c) => c.mod), ["pi-foreman"]);
  assert.equal(fs.existsSync(modDir(env, "pi-foreman-plan")), false);
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: env.home }), []);
});

test("an app home that does not exist gives nothing and is not created", () => {
  const env = fresh();
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: env.home }), []);
  assert.deepEqual(modsDoctorLines({ packageRoot: ROOT, appHome: env.home }), []);
  assert.deepEqual(refreshMods({ packageRoot: ROOT, appHome: env.home }), []);
  assert.equal(fs.existsSync(env.home), false);
});

test("appHome honours HERDR_APP_HOME and otherwise defaults to ~/.config/herdr-app on every OS", () => {
  assert.equal(appHome({ HERDR_APP_HOME: "/x/app" }, "/home/u"), "/x/app");
  assert.equal(appHome({}, "/home/u"), path.join("/home/u", ".config", "herdr-app"));
  assert.equal(appHome({ HERDR_APP_HOME: "" }, "/home/u"), path.join("/home/u", ".config", "herdr-app"));
});

test("a refresh copies exactly the differing files, keeps cache/ and installed-only files, and copies no test file", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman-plan");
  const planDir = modDir(env, "pi-foreman-plan");
  fs.appendFileSync(path.join(planDir, "main.js"), "// local edit\n");
  fs.rmSync(path.join(planDir, "model.js"));
  fs.mkdirSync(path.join(planDir, "cache"));
  fs.writeFileSync(path.join(planDir, "cache", "a.svg"), "<svg/>");
  fs.writeFileSync(path.join(planDir, "notes.txt"), "mine");
  const old = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path.join(planDir, "mod.json"), old, old);
  const changed = refreshMods({ packageRoot: ROOT, appHome: env.home });
  assert.deepEqual(changed, [{ mod: "pi-foreman-plan", files: ["main.js", "model.js"] }]);
  assert.equal(fs.readFileSync(path.join(planDir, "main.js"), "utf8"), fs.readFileSync(path.join(PKG, "pi-foreman-plan", "main.js"), "utf8"));
  assert.equal(fs.readFileSync(path.join(planDir, "model.js"), "utf8"), fs.readFileSync(path.join(PKG, "pi-foreman-plan", "model.js"), "utf8"));
  assert.equal(fs.readFileSync(path.join(planDir, "cache", "a.svg"), "utf8"), "<svg/>");
  assert.equal(fs.readFileSync(path.join(planDir, "notes.txt"), "utf8"), "mine");
  assert.equal(fs.statSync(path.join(planDir, "mod.json")).mtime.getTime(), old.getTime());
  assert.equal(fs.readdirSync(planDir).some((f) => f.endsWith(".test.mjs")), false);
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: env.home }), []);
});

test("a dry run writes nothing and lists the same files as the real refresh", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const before = snapshot(env.home);
  const dry = refreshMods({ packageRoot: ROOT, appHome: env.home, dryRun: true });
  assert.deepEqual(snapshot(env.home), before);
  const real = refreshMods({ packageRoot: ROOT, appHome: env.home });
  assert.deepEqual(dry, real);
});

// ---------------------------------------------------------------- foreman setup --mods

test("setup --mods refreshes the changed files, prints the next step, and leaves the agent dir alone", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const agentBefore = snapshot(env.agentDir);
  const r = setup(env, ["--mods"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /herdr-app mods: refreshed from the package:\n {2}pi-foreman: model\.js\n/);
  assert.match(r.out, /next: save reloads a mod/);
  assert.match(r.out, new RegExp(`then run: herdr-app check ${escapeRe(modDir(env, "pi-foreman"))}`));
  assert.doesNotMatch(r.out, /pi install|pi-foreman installer/);
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: env.home }), []);
  assert.deepEqual(snapshot(env.agentDir), agentBefore);
  assert.equal(fs.existsSync(env.log), false);
});

test("setup --mods --dry-run lists the changes and writes nothing", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const before = snapshot(env.home);
  const r = setup(env, ["--mods", "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry run, nothing written\. Would copy from the package:\n {2}pi-foreman: model\.js\n/);
  assert.deepEqual(snapshot(env.home), before);
});

test("setup --mods with no mod installed, or everything in step, says nothing to do", () => {
  const env = fresh();
  const none = setup(env, ["--mods"]);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /no mod is installed under .*; nothing to do\./);
  assert.equal(fs.existsSync(env.home), false);
  installMod(env.home, "pi-foreman");
  const inStep = setup(env, ["--mods"]);
  assert.equal(inStep.code, 0, inStep.out);
  assert.match(inStep.out, /herdr-app mods: nothing to do, the installed mods match the package \(pi-foreman\)\./);
});

test("setup --mods refuses to combine with the setup flags that write config", () => {
  const env = fresh();
  const r = setup(env, ["--mods", "--profile", "standard"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--mods only refreshes the app mods and cannot be combined with --profile/);
});

// ---------------------------------------------------------------- the setup offer in a normal run

const OFFER_ARGS = ["--profile", "standard", "--no-addons"];

test("a normal setup with no installed mod prints no herdr-app lines", () => {
  const env = fresh();
  const r = setup(env, OFFER_ARGS);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /herdr-app/);
});

test("a normal setup lists the differing mod and refreshes it on a yes answer", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const r = setup(env, OFFER_ARGS, { input: "y\n", picker: "force" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /herdr-app mod pi-foreman differs from the package: model\.js/);
  assert.match(r.out, /Refresh the installed herdr-app mods from this package\? \[Y\/n\]: /);
  assert.match(r.out, /next: save reloads a mod/);
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: env.home }), []);
});

test("a normal setup keeps the mod on a no answer and on EOF, and prints the fix command", () => {
  for (const input of ["n\n", ""]) {
    const env = fresh();
    installMod(env.home, "pi-foreman");
    fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
    const before = snapshot(env.home);
    const r = setup(env, OFFER_ARGS, { input, picker: "force" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /not refreshed; refresh with: foreman setup --mods/);
    assert.deepEqual(snapshot(env.home), before);
  }
});

test("a normal setup without a terminal only reports the differing mod, never asks, and does not refresh", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const before = snapshot(env.home);
  const r = setup(env, OFFER_ARGS, { input: "y\n" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /refresh with: foreman setup --mods/);
  assert.doesNotMatch(r.out, /\[Y\/n\]/);
  assert.deepEqual(snapshot(env.home), before);
});

test("a normal --dry-run setup reports the differing mod and writes nothing to it", () => {
  const env = fresh();
  installMod(env.home, "pi-foreman");
  fs.appendFileSync(path.join(modDir(env, "pi-foreman"), "model.js"), "// local edit\n");
  const before = snapshot(env.home);
  const r = setup(env, [...OFFER_ARGS, "--dry-run"], { input: "y\n", picker: "force" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /herdr-app mod pi-foreman differs from the package: model\.js/);
  assert.match(r.out, /refresh with: foreman setup --mods \(dry run lists only\)/);
  assert.doesNotMatch(r.out, /\[Y\/n\]/);
  assert.deepEqual(snapshot(env.home), before);
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
