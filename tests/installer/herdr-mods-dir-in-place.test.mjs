// A folder where a mod file belongs is a differing file: the diff names it, the doctor lines name it, nothing throws, and a refresh leaves the folder alone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const { diffMods, modsDoctorLines, refreshMods } = await import(pathToFileURL(path.join(ROOT, "extensions", "core-adapter", "profiles.mjs")).href);

const { splitBlockedMods } = await import(pathToFileURL(path.join(ROOT, "extensions", "core-adapter", "profiles.mjs")).href);

const bases = [];
after(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

test("a folder in place of a mod file is reported as differing; refresh keeps the folder and its content", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-herdr-mods-dir-")));
  bases.push(home);
  const mod = path.join(home, "mods", "pi-foreman");
  fs.cpSync(path.join(ROOT, "integrations", "herdr-app", "pi-foreman"), mod, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  fs.rmSync(path.join(mod, "model.js"));
  fs.mkdirSync(path.join(mod, "model.js"));
  fs.writeFileSync(path.join(mod, "model.js", "keep.txt"), "mine\n");
  assert.deepEqual(diffMods({ packageRoot: ROOT, appHome: home }), [{ mod: "pi-foreman", files: ["model.js"] }]);
  assert.deepEqual(modsDoctorLines({ packageRoot: ROOT, appHome: home }), [
    "WARN herdr-app mod pi-foreman differs from the package: model.js — fix: foreman setup --mods",
  ]);
  assert.deepEqual(refreshMods({ packageRoot: ROOT, appHome: home }), [{ mod: "pi-foreman", files: ["model.js"] }]);
  assert.equal(fs.readFileSync(path.join(mod, "model.js", "keep.txt"), "utf8"), "mine\n");
});

const MODS_ENV = (home) => ({ ...process.env, CI: undefined, HERDR_APP_HOME: home, PI_FOREMAN_PICKER: "off" });
const runMods = (home, args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), "--mods", ...args], { encoding: "utf8", env: MODS_ENV(home) });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test("setup --mods does not list a folder in place of a mod file as refreshed, and names it", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-herdr-mods-dir-cli-")));
  bases.push(home);
  const mod = path.join(home, "mods", "pi-foreman");
  fs.cpSync(path.join(ROOT, "integrations", "herdr-app", "pi-foreman"), mod, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  fs.rmSync(path.join(mod, "model.js"));
  fs.mkdirSync(path.join(mod, "model.js"));
  fs.appendFileSync(path.join(mod, "main.js"), "// local edit\n");
  const dry = runMods(home, ["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Would copy from the package:\n {2}pi-foreman: main\.js\n/);
  assert.match(dry.out, /pi-foreman: model\.js not written: a folder is in the place of a mod file/);
  const r = runMods(home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /herdr-app mods: refreshed from the package:\n {2}pi-foreman: main\.js\n {2}pi-foreman: model\.js not written: a folder is in the place of a mod file \(or a file in the place of a mod folder\); move or remove it, then foreman setup --mods refreshes it\.\n/);
  assert.doesNotMatch(r.out, /main\.js, model\.js|model\.js, main\.js/);
  fs.rmSync(path.join(mod, "model.js"), { recursive: true });
  assert.match(runMods(home, []).out, /refreshed from the package:\n {2}pi-foreman: model\.js\n/);
});

test("a file where a source sub-folder belongs does not throw: it is reported, not written", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-herdr-mods-rev-")));
  bases.push(base);
  const pkg = path.join(base, "pkg");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(pkg, "integrations", "herdr-app", "pi-foreman", "a"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "integrations", "herdr-app", "pi-foreman", "a", "b.js"), "x\n");
  fs.writeFileSync(path.join(pkg, "integrations", "herdr-app", "pi-foreman", "c.js"), "y\n");
  fs.mkdirSync(path.join(home, "mods", "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(home, "mods", "pi-foreman", "a"), "i am a file\n");
  const opts = { packageRoot: pkg, appHome: home };
  assert.deepEqual(diffMods(opts), [{ mod: "pi-foreman", files: ["a/b.js", "c.js"] }]);
  assert.deepEqual(splitBlockedMods(home, diffMods(opts)), { writable: [{ mod: "pi-foreman", files: ["c.js"] }], blocked: [{ mod: "pi-foreman", files: ["a/b.js"] }] });
  assert.doesNotThrow(() => refreshMods(opts));
  assert.equal(fs.readFileSync(path.join(home, "mods", "pi-foreman", "a"), "utf8"), "i am a file\n");
  assert.equal(fs.readFileSync(path.join(home, "mods", "pi-foreman", "c.js"), "utf8"), "y\n");
});
