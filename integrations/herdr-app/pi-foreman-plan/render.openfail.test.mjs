import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const URL_ = "https://example.org/o/r/pull/7";
const LSO = "_LSOpenURLsWithCompletionHandler() failed with error -600 for the URL https://example.org/o/r/pull/7.";
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const open = async (platform, execFn) => {
  world.execCalls = []; world.notices = []; world.platform = platform; world.execFn = execFn;
  const cx = { spawn: (f) => f(cx), notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  world.execCalls = [];
  m.openUrl(URL_, cx);
  await settle();
  world.platform = undefined; world.execFn = undefined;
};

test("an opener that exits non-zero raises one error notice with the exit code and the first stderr line", async () => {
  await open("macos", () => ({ code: 1, stdout: "", stderr: `${LSO}\nsecond line` }));
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /exit 1/);
  assert.ok(world.notices[0].body.includes(LSO));
  assert.ok(!world.notices[0].body.includes("second line"));
});

test("an opener that cannot run raises one error notice with its text", async () => {
  await open("macos", () => { throw new Error("cannot run open: program not found"); });
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /cannot run open: program not found/);
});

test("a successful open raises no notice and runs the opener with its timeout", async () => {
  await open("macos", () => ({ code: 0, stdout: "", stderr: "" }));
  assert.deepEqual(world.notices, []);
  assert.deepEqual(world.execCalls, [["open", [URL_], { timeout: 10000 }]]);
});
