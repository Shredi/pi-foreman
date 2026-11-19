// pi-background-tasks ships with pi-foreman: the start defaults, the bundled peer-range lookup, the tool floor and the bundle pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { applyBgAddonDefaults } from "../bgshell.ts";
import { addonPackageDir, addonPeerRangeLine } from "../bg.ts";
import { TOOL_FLOOR } from "../toolfloor.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));

test("applyBgAddonDefaults sets both variables only when unset and keeps a user's value, empty string included", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(applyBgAddonDefaults(env), ["PI_BG_FEATURES", "PI_BG_DISABLE_UPDATE_CHECK"]);
  assert.deepEqual({ ...env }, { PI_BG_FEATURES: "process", PI_BG_DISABLE_UPDATE_CHECK: "1" });
  const mine: NodeJS.ProcessEnv = { PI_BG_FEATURES: "process,attribution", PI_BG_DISABLE_UPDATE_CHECK: "" };
  assert.deepEqual(applyBgAddonDefaults(mine), []);
  assert.deepEqual({ ...mine }, { PI_BG_FEATURES: "process,attribution", PI_BG_DISABLE_UPDATE_CHECK: "" });
});

test("the factory applies the defaults to AdapterDeps.env, not to process.env, and never overrides a set value", (t) => {
  const saved = [process.env.PI_BG_FEATURES, process.env.PI_BG_DISABLE_UPDATE_CHECK];
  delete process.env.PI_BG_FEATURES;
  delete process.env.PI_BG_DISABLE_UPDATE_CHECK;
  t.after(() => {
    for (const [i, k] of (["PI_BG_FEATURES", "PI_BG_DISABLE_UPDATE_CHECK"] as const).entries()) {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    }
  });
  const pi = { on: () => undefined, registerCommand: () => undefined, registerTool: () => undefined, getActiveTools: () => [] as string[], getAllTools: () => [], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined, sendMessage: () => undefined };
  const env: NodeJS.ProcessEnv = {};
  coreAdapter(pi as never, { env });
  assert.equal(env.PI_BG_FEATURES, "process");
  assert.equal(env.PI_BG_DISABLE_UPDATE_CHECK, "1");
  assert.equal(process.env.PI_BG_FEATURES, undefined);
  const user: NodeJS.ProcessEnv = { PI_BG_FEATURES: "process,attribution" };
  coreAdapter(pi as never, { env: user });
  assert.equal(user.PI_BG_FEATURES, "process,attribution");
});

test("the peer-range line finds the bundled copy under <root>/node_modules", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-bg-bundled-")));
  t.after(() => rmTestTmp(root));
  const dirs = { agentDir: path.join(root, "agent"), cwd: path.join(root, "proj"), bundledRoot: path.join(root, "pkg") };
  assert.equal(addonPackageDir(dirs), null);
  const dir = path.join(dirs.bundledRoot, "node_modules", "pi-background-tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-background-tasks", peerDependencies: { "@earendil-works/pi-coding-agent": "^1.2.0" } }));
  assert.equal(addonPackageDir(dirs), dir);
  assert.equal(addonPeerRangeLine(dirs, "1.2.0"), "INFO pi-background-tasks peer range for @earendil-works/pi-coding-agent: ^1.2.0; running Pi 1.2.0 is inside it");
  assert.equal(addonPackageDir({ ...dirs, bundledRoot: undefined }), null, "without bundledRoot the lookup is the old one");
  const outside = addonPeerRangeLine(dirs, "9.0.0");
  assert.equal(outside, "INFO pi-background-tasks peer range for @earendil-works/pi-coding-agent: ^1.2.0; running Pi 9.0.0 is outside it (the copy bundled with pi-foreman; a newer one arrives with a pi-foreman update)");
});

test("TOOL_FLOOR holds bg_run and no longer foreman_bg", () => {
  assert.ok(TOOL_FLOOR.includes("bg_run"));
  assert.ok(!TOOL_FLOOR.includes("foreman_bg"));
});

test("bundle pins: exact dependency, the add-on's two extensions right after the core adapter, files present, lock, NOTICE, renovate", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.dependencies["pi-background-tasks"], "2.6.10");
  const ext: string[] = pkg.pi.extensions;
  const at = ext.indexOf("./extensions/core-adapter/index.ts");
  assert.equal(at, 0);
  assert.deepEqual(ext.slice(1, 3), ["./node_modules/pi-background-tasks/dist/extensions/anthropic-attribution.js", "./node_modules/pi-background-tasks/dist/extensions/background-tasks.js"]);
  for (const e of ext.slice(1, 3)) assert.ok(fs.existsSync(path.join(ROOT, e)), e);
  const lock = readJson("packages.lock.json");
  const entry = (lock.packages ?? lock).find((p: { name: string }) => p.name === "pi-background-tasks");
  assert.equal(entry.version, "2.6.10");
  assert.equal(entry.mode, "bundled");
  assert.match(fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8"), /pi-background-tasks 2\.6\.10, ISC License/);
  const renovate = readJson("renovate.json");
  assert.ok(renovate.packageRules.some((r: { groupName?: string; matchPackageNames: string[] }) => r.groupName === "pi packages" && r.matchPackageNames.includes("pi-background-tasks")));
});
