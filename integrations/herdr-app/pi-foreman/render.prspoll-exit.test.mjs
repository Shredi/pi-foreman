// pollPrs: a poll that exits non-zero raises one error notice (first stderr line as the reason); a poll that exits 0 clears it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

function mod() {
  const m = Object.create(Mod.prototype);
  m.radar = new Map(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set();
  m.foremanProp = undefined; m.hcProp = undefined;
  m.machines = () => [null];
  return m;
}
const run = async (m, result) => {
  stubs.world.execFn = async () => result;
  const tasks = [];
  const cx = { spawn: (f) => tasks.push(f), notify() {}, sleep: () => new Promise(() => {}) };
  m.pollPrs(cx, Date.now() + 1e9 * (m.rounds = (m.rounds ?? 0) + 1));
  for (const t of tasks) await t(cx);
};

test("code 1 raises one notice with the first stderr line, a second failing run adds none, code 0 clears it", async () => {
  stubs.world.notices = [];
  const m = mod();
  await run(m, { code: 1, stdout: "", stderr: "\nforeman prs needs Node >= 22.6 (--experimental-strip-types)\nmore" });
  assert.equal(stubs.world.notices.length, 1);
  assert.equal(stubs.world.notices[0].title, "Foreman PR poll failed");
  assert.equal(stubs.world.notices[0].level, "error");
  assert.match(stubs.world.notices[0].body, /needs Node >= 22\.6/);
  assert.ok(!stubs.world.notices[0].body.includes("more"));
  await run(m, { code: 1, stdout: "", stderr: "again" });
  assert.equal(stubs.world.notices.length, 1, "one notice while it keeps failing");
  await run(m, { code: 0, stdout: "{}" });
  assert.equal(m.failed.size, 0, "code 0 clears");
  await run(m, { code: 2, stdout: "out line", stderr: "" });
  assert.equal(stubs.world.notices.length, 2, "a new failure after a clear notifies again");
  assert.match(stubs.world.notices[1].body, /exit 2/);
  stubs.world.execFn = null;
});
