// Screen snapshots: each screen is drawn from setup/fixtures/preview.json through the frame-capture terminal
// and compared to tests/installer/screens/<name>-<cols>x<rows>.snap.txt (UPDATE_SNAPSHOTS=1 rewrites them).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SNAPS = path.join(HERE, "screens");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { SetupApp } = await load("setup/tui/app.ts");
const { CaptureTerminal, renderFrame } = await load("setup/tui/term.ts");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "setup/fixtures/preview.json"), "utf8"));

const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const RIGHT = "\x1b[C";

// [snapshot name, screen id, key script]
const CASES = [
  ["home", "home", []],
  ["plan", "plan", []],
  ["plan-diff", "plan", [DOWN, DOWN, DOWN]],
  ["plan-diff-scrolled", "plan", [DOWN, DOWN, DOWN, PAGE_DOWN]],
  ["plan-permission", "plan", [DOWN, DOWN, DOWN, DOWN]],
  ["updates", "updates", []],
  ["updates-unmanaged", "updates", Array(10).fill(DOWN)],
  ["config", "config", []],
  ["config-selected", "config", [DOWN, DOWN, PAGE_DOWN]],
  ["models", "models", []],
  ["models-selected", "models", [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, RIGHT]],
  ["workfolders", "workfolders", []],
  ["apply", "apply", []],
];

function frame(id, keys, cols, rows) {
  const app = new SetupApp(fixture, new CaptureTerminal(cols, rows));
  app.showScreen(id);
  for (const k of keys) app.handleInput(k);
  return renderFrame(app, cols, rows).join("\n") + "\n";
}

for (const [cols, rows] of [[100, 30], [80, 24]]) {
  for (const [name, id, keys] of CASES) {
    test(`screen ${name} at ${cols}x${rows} matches its snapshot`, () => {
      const file = path.join(SNAPS, `${name}-${cols}x${rows}.snap.txt`);
      const got = frame(id, keys, cols, rows);
      assert.equal(got.split("\n").length - 1, rows);
      if (process.env.UPDATE_SNAPSHOTS === "1") {
        fs.mkdirSync(SNAPS, { recursive: true });
        fs.writeFileSync(file, got);
      }
      assert.equal(got, fs.readFileSync(file, "utf8"));
    });
  }
}

test("number keys and Tab switch screens, q is handled by the app", () => {
  const app = new SetupApp(fixture, new CaptureTerminal(100, 30));
  app.handleInput("4");
  assert.equal(app.current, "config");
  app.handleInput("\t");
  assert.equal(app.current, "models");
  app.handleInput("\x1b[Z");
  assert.equal(app.current, "config");
});

test("every screen renders at 100x30, 80x24 and 60x20 without throwing", () => {
  for (const { id } of fixture.screens) {
    for (const [cols, rows] of [[100, 30], [80, 24], [60, 20]]) {
      const lines = frame(id, [DOWN, DOWN, RIGHT, PAGE_DOWN], cols, rows).split("\n");
      assert.equal(lines.length - 1, rows, `${id} at ${cols}x${rows}`);
    }
  }
});

const preview = (...args) => spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), ...args], { encoding: "utf8", env: { ...process.env, PI_FOREMAN_PICKER: "off" } });

test("--preview plan without a TTY prints one 100x30 frame and exits 0", () => {
  const r = preview("--preview", "plan");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n").length - 1, 30);
  assert.equal(r.stdout, fs.readFileSync(path.join(SNAPS, "plan-100x30.snap.txt"), "utf8"));
});

test("--preview=home works with the inline form", () => {
  const r = preview("--preview=home");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date, \d+ updates available/);
});

test("--preview with an unknown screen exits 2 and lists the ids", () => {
  const r = preview("--preview", "nope");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /home, plan, updates, config, models, workfolders, apply/);
});

test("--preview cannot be combined with another action flag", () => {
  const r = preview("--preview", "--dry-run");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--preview cannot be combined with --dry-run/);
});
