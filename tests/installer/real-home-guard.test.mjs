// The real-home guard (setup/real-home.mjs): under the Node test runner (NODE_TEST_CONTEXT) setup refuses the real default places.
// Unit tests inject a temp dir as the real home. Spawn tests run setup with --dry-run (writes nothing) or with temp HOME dirs only.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./_sandbox-home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const { protectedPlaces, realHomeDir, realHomeGuard, writeTargets, applyRealHomeGuard } = await import(pathToFileURL(path.join(ROOT, "setup", "real-home.mjs")).href);

const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const SIGNAL = { NODE_TEST_CONTEXT: "child-v8" };
const guard = (targets, extra = {}, home = "/fake/real-home", platform = "linux") => realHomeGuard({ env: { ...SIGNAL, ...extra }, targets, realHome: home, platform });

test("a target in each protected place is refused under the signal", () => {
  const home = tmp("pf-rh-");
  try {
    const host = process.platform; // real temp dirs carry the host's path flavour
    for (const place of protectedPlaces(home, host)) {
      assert.equal(guard([place], {}, home, host), place);
      assert.equal(guard([path.join(place, "x", "y")], {}, home, host), path.join(place, "x", "y"));
    }
    assert.ok(protectedPlaces(home, host).includes(path.join(home, ".zshrc")));
    assert.ok(protectedPlaces(home, host).includes(path.join(home, "Documents", "PowerShell")));
    assert.ok(protectedPlaces(home, host).includes(path.join(home, ".pi", "agent")));
    assert.ok(protectedPlaces(home, host).includes(path.join(home, ".config", "herdr-app")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a target elsewhere is not refused, also a temp dir inside the real home outside the places", () => {
  const home = tmp("pf-rh-");
  try {
    assert.equal(guard([path.join(os.tmpdir(), "pf-else", ".zshrc"), path.join(home, "scratch", ".zshrc"), path.join(home, ".pi", "other")], {}, home, process.platform), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the override and a missing signal let every target through", () => {
  const targets = ["/fake/real-home/.zshrc", "/fake/real-home/.pi/agent"];
  assert.equal(guard(targets, { PI_FOREMAN_ALLOW_REAL_HOME: "1" }), null);
  assert.equal(realHomeGuard({ env: {}, targets, realHome: "/fake/real-home", platform: "linux" }), null);
  assert.equal(realHomeGuard({ env: { NODE_TEST_CONTEXT: "" }, targets, realHome: "/fake/real-home", platform: "linux" }), null);
  assert.equal(guard(targets, { PI_FOREMAN_ALLOW_REAL_HOME: "0" }), targets[0]);
});

test("the comparison ignores case on win32 and darwin, not on linux", () => {
  const t = ["/FAKE/Real-Home/.ZSHRC"];
  assert.equal(guard(t, {}, "/fake/real-home", "darwin"), t[0]);
  assert.equal(guard(t, {}, "/fake/real-home", "win32"), t[0]);
  assert.equal(guard(t, {}, "/fake/real-home", "linux"), null);
});

test("remove targets are guarded like write targets", () => {
  const targets = writeTargets({ env: SIGNAL, home: "/fake/real-home", agentDir: "/fake/real-home/.pi/agent", platform: "linux" });
  assert.ok(targets.includes("/fake/real-home/.zshrc"));
  assert.equal(guard(targets), "/fake/real-home/.zshrc");
  assert.equal(guard(writeTargets({ env: SIGNAL, agentDir: "/fake/real-home/.pi/agent", platform: "linux" })), "/fake/real-home/.pi/agent");
  assert.equal(guard(writeTargets({ env: SIGNAL, appHome: "/fake/real-home/.config/herdr-app", platform: "linux" })), "/fake/real-home/.config/herdr-app");
  // win32 targets use backslashes whatever the host is
  const win = writeTargets({ env: SIGNAL, home: "C:\\Users\\real", agentDir: "C:\\Users\\real\\.pi\\agent", platform: "win32", pathPlatform: "win32" });
  assert.ok(win.includes("C:\\Users\\real\\.zshrc"));
  assert.equal(guard(win, {}, "C:\\Users\\real", "win32"), "C:\\Users\\real\\.zshrc");
  assert.equal(guard(["c:\\users\\REAL\\.pi\\agent\\x"], {}, "C:\\Users\\real", "win32"), "c:\\users\\REAL\\.pi\\agent\\x");
  assert.equal(guard(["C:\\Users\\real\\.pi\\other"], {}, "C:\\Users\\real", "win32"), null);
});

test("the PowerShell Documents query is a protected target on win32 without PI_FOREMAN_HOME and PI_FOREMAN_TEST_PS_DOCUMENTS", () => {
  const targets = writeTargets({ env: SIGNAL, home: "/fake/real-home", platform: "win32" });
  const refused = guard(targets.filter((t) => /query/.test(t)), {}, "/fake/real-home", "win32");
  assert.match(refused, /PowerShell Documents folder query/);
  // not on another platform, and not with the home or the documents seam
  assert.ok(!writeTargets({ env: SIGNAL, home: "/fake/real-home", platform: "linux" }).some((t) => /query/.test(t)));
  assert.ok(!writeTargets({ env: { ...SIGNAL, PI_FOREMAN_HOME: "/tmp/h" }, home: "/tmp/h", platform: "win32" }).some((t) => /query/.test(t)));
});

test("with PI_FOREMAN_TEST_PS_DOCUMENTS the target is that path, not refused for a temp folder", () => {
  // win32 paths are spelled out: the guard resolves them with path.win32 on any host
  const docs = "C:\\Temp\\pf-rh-docs";
  const home = "C:\\Users\\real";
  const env = { ...SIGNAL, PI_FOREMAN_TEST_PS_DOCUMENTS: docs };
  const targets = writeTargets({ env, home, platform: "win32" });
  assert.ok(targets.includes(path.win32.join(docs, "PowerShell")));
  assert.ok(!targets.some((t) => /query/.test(t)));
  assert.equal(guard(targets.filter((t) => t.startsWith(docs)), {}, home, "win32"), null);
  // a Documents seam that names the real profile folder is refused
  const seam = writeTargets({ env: { ...SIGNAL, PI_FOREMAN_TEST_PS_DOCUMENTS: `${home}\\Documents` }, platform: "win32", home: "C:\\x" }).filter((t) => t.startsWith(home));
  assert.equal(guard(seam, {}, home, "win32"), `${home}\\Documents\\PowerShell`);
});

test("realHomeDir uses os.userInfo, and os.homedir when userInfo throws", () => {
  assert.equal(realHomeDir({ userInfo: () => ({ homedir: "/from/userinfo" }), homedir: () => "/from/homedir" }), "/from/userinfo");
  assert.equal(realHomeDir({ userInfo: () => { throw new Error("ENOENT"); }, homedir: () => "/from/homedir" }), "/from/homedir");
  assert.equal(realHomeDir(), os.userInfo().homedir);
});

test("applyRealHomeGuard: refusal throws exit 2 naming the path, NODE_TEST_CONTEXT and the override; dry prints; null does nothing", () => {
  assert.throws(() => applyRealHomeGuard("/real/.zshrc", false), (e) => e.code === 2 && /\/real\/\.zshrc/.test(e.message) && /NODE_TEST_CONTEXT/.test(e.message) && /PI_FOREMAN_ALLOW_REAL_HOME=1/.test(e.message));
  class F extends Error {}
  assert.throws(() => applyRealHomeGuard("/real/x", false, { fatal: (m) => new F(m) }), F);
  const lines = [];
  applyRealHomeGuard("/real/.zshrc", true, { say: (l) => lines.push(l) });
  assert.deepEqual(lines, ["real-home guard: would refuse /real/.zshrc"]);
  applyRealHomeGuard(null, false, { say: (l) => lines.push(l) });
  applyRealHomeGuard(null, true, { say: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
});

function setup(args, env, cwd) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), ...args], { cwd, encoding: "utf8", input: "", env: { ...process.env, PI_FOREMAN_PI_BIN: FAKE_PI, PI_FOREMAN_PICKER: "off", ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("setup --dry-run with the signal and the real default places prints would refuse and writes nothing", () => {
  const base = tmp("pf-rh-dry-");
  try {
    const realHome = os.userInfo().homedir;
    const env = { NODE_TEST_CONTEXT: "child-v8", PI_FOREMAN_HOME: undefined, PI_FOREMAN_PLATFORM: "linux", SHELL: "/bin/zsh", HOME: base, FAKE_PI_LOG: path.join(base, "calls.jsonl"), PI_FOREMAN_PI_AI_DATA: path.join(base, "no-models"), HERDR_APP_HOME: path.join(base, "app") };
    const r = setup(["--dry-run", "--no-addons", "--agent-dir", path.join(realHome, ".pi", "agent")], env, base);
    assert.match(r.out, /real-home guard: would refuse /);
    assert.deepEqual(fs.readdirSync(base).filter((f) => f !== "calls.jsonl"), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("setup --dry-run with the picker allowed and the herdr-app home at the real default prints would refuse for it", () => {
  const base = tmp("pf-rh-app-");
  try {
    const home = path.join(base, "home");
    const agentDir = path.join(base, "agent");
    fs.mkdirSync(home);
    fs.mkdirSync(agentDir);
    const app = path.join(os.userInfo().homedir, ".config", "herdr-app");
    const env = { NODE_TEST_CONTEXT: "child-v8", PI_FOREMAN_PICKER: "force", PI_FOREMAN_HOME: home, PI_FOREMAN_PLATFORM: "linux", HOME: os.userInfo().homedir, SHELL: "/bin/zsh", HERDR_APP_HOME: undefined, FAKE_PI_LOG: path.join(base, "calls.jsonl"), PI_FOREMAN_PI_AI_DATA: path.join(base, "no-models") };
    const r = setup(["--dry-run", "--no-addons", "--agent-dir", agentDir], env, base);
    assert.match(r.out, new RegExp(`real-home guard: would refuse ${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual(fs.readdirSync(base).filter((f) => f !== "calls.jsonl").sort(), ["agent", "home"]);
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(fs.readdirSync(agentDir), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a child named ..x inside a protected place is inside, a parent-relative path is outside", () => {
  const t = ["/fake/real-home/.pi/agent/..x/y"];
  assert.equal(guard(t), t[0]);
  assert.equal(guard(["/fake/real-home/.pi/agent/.."]), null);
  assert.equal(guard(["/fake/real-home/.pi/agent/../other"]), null);
});

test("the PowerShell query refusal names PI_FOREMAN_TEST_PS_DOCUMENTS", () => {
  const q = writeTargets({ env: SIGNAL, home: "/fake/real-home", platform: "win32" }).find((t) => /query/.test(t));
  assert.throws(() => applyRealHomeGuard(q, false), (e) => /PI_FOREMAN_TEST_PS_DOCUMENTS/.test(e.message) && /PI_FOREMAN_ALLOW_REAL_HOME=1/.test(e.message));
  assert.throws(() => applyRealHomeGuard("/real/.zshrc", false), (e) => !/PI_FOREMAN_TEST_PS_DOCUMENTS/.test(e.message));
});

test("setup --dry-run --mods with the herdr-app home at the real default prints would refuse", () => {
  const base = tmp("pf-rh-mods-");
  try {
    const app = path.join(os.userInfo().homedir, ".config", "herdr-app");
    const r = setup(["--dry-run", "--mods"], { NODE_TEST_CONTEXT: "child-v8", HERDR_APP_HOME: app, PI_FOREMAN_HOME: path.join(base, "home") }, base);
    assert.match(r.out, new RegExp(`real-home guard: would refuse ${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("setup with PI_FOREMAN_HOME and --agent-dir in temp dirs under the signal does not refuse and writes into them", () => {
  const base = tmp("pf-rh-ok-");
  try {
    const home = path.join(base, "home");
    const agentDir = path.join(base, "agent");
    const app = path.join(base, "app");
    for (const d of [home, agentDir, app, path.join(base, "project")]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`);
    const env = { NODE_TEST_CONTEXT: "child-v8", CI: "1", PI_FOREMAN_HOME: home, PI_CODING_AGENT_DIR: agentDir, HERDR_APP_HOME: app, SHELL: "/bin/zsh", PI_FOREMAN_PLATFORM: "linux", FAKE_PI_LOG: path.join(base, "calls.jsonl"), PI_FOREMAN_PI_AI_DATA: path.join(base, "no-models"), PI_BG_FEATURES: undefined };
    const r = setup(["--no-addons", "--agent-dir", agentDir], env, path.join(base, "project"));
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /would refuse|refusing to write/);
    assert.ok(fs.existsSync(path.join(home, ".zshrc")));
    assert.ok(fs.existsSync(path.join(agentDir, "pi-foreman", "managed.json")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("on Windows os.userInfo().homedir ignores a USERPROFILE override", { skip: process.platform !== "win32" && "windows only" }, () => {
  const fake = tmp("pf-rh-up-");
  try {
    const r = spawnSync(process.execPath, ["-e", "console.log(require('node:os').userInfo().homedir)"], { encoding: "utf8", env: { ...process.env, USERPROFILE: fake, HOME: fake } });
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(path.resolve(r.stdout.trim()).toLowerCase(), path.resolve(fake).toLowerCase());
    assert.equal(path.resolve(r.stdout.trim()).toLowerCase(), path.resolve(os.userInfo().homedir).toLowerCase());
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});
