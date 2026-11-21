import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;

const boot = (props) => {
  world.props = props;
  const cx = { spawn: (f) => void f(cx), notify() {}, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  return m;
};
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const reset = () => { world.execCalls = []; world.notices = []; world.execFn = () => ({ code: 1, stdout: "" }); world.agents = []; world.spaces = []; };
const ensures = () => world.execCalls.filter((c) => c[1][0] === "pages");
test.afterEach(() => { world.props = undefined; world.execFn = undefined; });

test("the Agents mod runs `<foreman> pages ensure` once at start, with the binary of the foreman prop and a timeout", async () => {
  reset();
  boot({ foreman: "/opt/bin/foreman" });
  await settle();
  assert.deepEqual(ensures(), [["/opt/bin/foreman", ["pages", "ensure"], { timeout: 5000 }]]);
});

test("without a foreman prop the binary is plain foreman", async () => {
  reset();
  boot({});
  await settle();
  assert.deepEqual(ensures().map((c) => c[0]), ["foreman"]);
});

test("the answer is ignored: a failing or throwing ensure raises no notice and no second run", async () => {
  reset();
  world.execFn = (cmd, args) => { if (args[0] === "pages") throw new Error("cannot start foreman: program not found"); return { code: 1, stdout: "" }; };
  boot({});
  await settle();
  assert.equal(ensures().length, 1);
  assert.ok(!(world.notices ?? []).some((n) => /pages/.test(JSON.stringify(n))));
});
