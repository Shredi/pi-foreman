// R30 item 8: a child's `bash` call with no valid `timeout` gets ceremony.childBashTimeoutSeconds (600); an explicit one above
// ceremony.childBashTimeoutMaxSeconds (3600) is capped; the foreman's calls are untouched. Trace `bash_timeout`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { childBashTimeout } from "../bashtimeout.ts";
import { r11Rig } from "./_r11rig.ts";

const cfg = {};

test("a missing timeout gets the default 600, applied", () => {
  assert.deepEqual(childBashTimeout({ command: "npm test" }, cfg), { timeout: 600, action: "applied", requested: null });
});

test("a timeout within the cap is kept (no change)", () => {
  assert.equal(childBashTimeout({ command: "npm test", timeout: 1200 }, cfg), null);
  assert.equal(childBashTimeout({ command: "npm test", timeout: 3600 }, cfg), null);
});

test("a timeout above the cap is capped at 3600", () => {
  assert.deepEqual(childBashTimeout({ command: "bench", timeout: 7200 }, cfg), { timeout: 3600, action: "capped", requested: 7200 });
});

test("a non-numeric, zero or negative timeout gets the default", () => {
  assert.deepEqual(childBashTimeout({ command: "x", timeout: "soon" }, cfg), { timeout: 600, action: "applied", requested: null });
  assert.deepEqual(childBashTimeout({ command: "x", timeout: 0 }, cfg), { timeout: 600, action: "applied", requested: 0 });
  assert.deepEqual(childBashTimeout({ command: "x", timeout: -5 }, cfg), { timeout: 600, action: "applied", requested: -5 });
  assert.deepEqual(childBashTimeout({ command: "x", timeout: NaN }, cfg), { timeout: 600, action: "applied", requested: null });
});

test("custom keys are honoured; invalid config values fall back to the defaults", () => {
  assert.deepEqual(childBashTimeout({ command: "x" }, { seconds: 300 }), { timeout: 300, action: "applied", requested: null });
  assert.deepEqual(childBashTimeout({ command: "x", timeout: 900 }, { max: 600 }), { timeout: 600, action: "capped", requested: 900 });
  assert.deepEqual(childBashTimeout({ command: "x" }, { seconds: 0 }), { timeout: 600, action: "applied", requested: null });
  assert.deepEqual(childBashTimeout({ command: "x", timeout: 5000 }, { max: "big" }), { timeout: 3600, action: "capped", requested: 5000 });
});

test("the adapter's child bash call gets the default and a bash_timeout trace; a cap is traced too", async (t) => {
  const rig = await r11Rig(t, { childBashTimeoutMaxSeconds: 900 }, { child: true });
  const missing: Record<string, unknown> = { command: "echo ok" };
  await rig.call("bash", missing);
  assert.equal(missing.timeout, 600);
  const big: Record<string, unknown> = { command: "echo ok", timeout: 7200 };
  await rig.call("bash", big);
  assert.equal(big.timeout, 900);
  const kept: Record<string, unknown> = { command: "echo ok", timeout: 120 };
  await rig.call("bash", kept);
  assert.equal(kept.timeout, 120);
  assert.deepEqual(rig.events("bash_timeout").map((r) => [r.action, r.requested]), [["applied", null], ["capped", 7200]]);
});

test("the foreman's bash call is not changed", async (t) => {
  const rig = await r11Rig(t);
  const input: Record<string, unknown> = { command: "echo ok" };
  await rig.call("bash", input);
  assert.equal("timeout" in input, false);
  assert.deepEqual(rig.events("bash_timeout"), []);
});
