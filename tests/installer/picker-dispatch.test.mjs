import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const { pickerKind, runPicker, INQUIRER_MISSING_NOTE } = await import(pathToFileURL(path.join(ROOT, "setup.mjs")).href);

const ctx = { currentText: null, currentConfig: {}, recorded: null, installed: [], project: false };

test("pickerKind: a real terminal gets the arrow-key menu, anything else the readline menu", () => {
  assert.equal(pickerKind({ tty: true }), "inquirer");
  assert.equal(pickerKind({ tty: false }), "readline");
});

test("runPicker on a terminal uses the loaded prompts and returns the picker shape", async () => {
  const asked = [];
  const prompts = {
    select: async (q) => {
      asked.push(`select:${q.default}`);
      return "orchestration";
    },
    confirm: async (q) => {
      asked.push(`confirm:${q.message}`);
      return q.message === "Apply?";
    },
    checkbox: async () => assert.fail("no feature adjustment was asked for"),
  };
  const r = await runPicker(ctx, { tty: true, load: async () => prompts });
  assert.deepEqual(r, { profile: "orchestration", enable: [], disable: [], addons: [] });
  assert.equal(asked[0], "select:standard");
  assert.equal(asked.at(-1), "confirm:Apply?");
});

test("runPicker: Ctrl-C in the arrow-key menu (ExitPromptError) gives null", async () => {
  const exit = Object.assign(new Error("User force closed the prompt"), { name: "ExitPromptError" });
  const r = await runPicker(ctx, {
    tty: true,
    load: async () => ({ select: async () => Promise.reject(exit), confirm: async () => false, checkbox: async () => [] }),
  });
  assert.equal(r, null);
});

test("runPicker: a failed import falls back to the readline menu with one note naming npm ci", () => {
  const probe = path.join(HERE, "fixtures", "picker-dispatch-probe.mjs");
  const r = spawnSync(process.execPath, [probe], { input: "\nn\nn\nn\n", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split(INQUIRER_MISSING_NOTE).length - 1, 1, r.stdout);
  assert.match(r.stdout, /Profiles:/, "the numbered menu ran");
  assert.match(r.stdout, /npm ci/);
  assert.match(r.stdout, /RESULT null/, "declining the final confirm gives null");
});
