// r71: CLAUDE_CODE_PROMPT_CACHE_TTL on the claude bridge (bridgettl.ts): cases E1-E5, the derived TTL and the setting reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_TTL_ENV, BridgeCacheTtl, bridgeTtlSetting, derivedBridgeTtlS, forced5m } from "../bridgettl.ts";

const DEFAULTS = bridgeTtlSetting(undefined);

test("defaults: main 1h, subagent 5m", () => {
  assert.deepEqual(DEFAULTS, { main: "1h", subagent: "5m" });
});

test("E1: the foreman on the bridge sets 1h", () => {
  const env: Record<string, string | undefined> = {};
  new BridgeCacheTtl().apply(env, DEFAULTS, "claude-bridge", false);
  assert.equal(env[BRIDGE_TTL_ENV], "1h");
});

test("E2: a subagent overrides an inherited 1h with 5m", () => {
  const env: Record<string, string | undefined> = { [BRIDGE_TTL_ENV]: "1h" };
  new BridgeCacheTtl().apply(env, DEFAULTS, "claude-bridge", true);
  assert.equal(env[BRIDGE_TTL_ENV], "5m");
});

test("E3: inherit leaves a value already set unchanged, and an unset variable unset", () => {
  const setting = bridgeTtlSetting({ main: "inherit", subagent: "inherit" });
  for (const isChild of [false, true]) {
    const set: Record<string, string | undefined> = { [BRIDGE_TTL_ENV]: "1h" };
    new BridgeCacheTtl().apply(set, setting, "claude-bridge", isChild);
    assert.equal(set[BRIDGE_TTL_ENV], "1h");
    const unset: Record<string, string | undefined> = {};
    new BridgeCacheTtl().apply(unset, setting, "claude-bridge", isChild);
    assert.equal(BRIDGE_TTL_ENV in unset, false);
  }
});

test("E4: switching away from the bridge restores the previous value, or deletes the variable", () => {
  const had: Record<string, string | undefined> = { [BRIDGE_TTL_ENV]: "5m" };
  const a = new BridgeCacheTtl();
  a.apply(had, DEFAULTS, "claude-bridge", false);
  assert.equal(had[BRIDGE_TTL_ENV], "1h");
  a.apply(had, DEFAULTS, "openai", false);
  assert.equal(had[BRIDGE_TTL_ENV], "5m");

  const none: Record<string, string | undefined> = {};
  const b = new BridgeCacheTtl();
  b.apply(none, DEFAULTS, "claude-bridge", false);
  b.apply(none, DEFAULTS, "claude-bridge", false); // a second apply keeps the first saved value
  b.apply(none, DEFAULTS, undefined, false);
  assert.equal(BRIDGE_TTL_ENV in none, false);
  // and back onto the bridge again
  b.apply(none, DEFAULTS, "claude-bridge", false);
  assert.equal(none[BRIDGE_TTL_ENV], "1h");
});

test("E5: a non-bridge provider from the start never touches the variable", () => {
  for (const prov of ["openai", "github-copilot", undefined]) {
    const set: Record<string, string | undefined> = { [BRIDGE_TTL_ENV]: "1h" };
    new BridgeCacheTtl().apply(set, DEFAULTS, prov, false);
    assert.equal(set[BRIDGE_TTL_ENV], "1h");
    const unset: Record<string, string | undefined> = {};
    new BridgeCacheTtl().apply(unset, DEFAULTS, prov, true);
    assert.equal(BRIDGE_TTL_ENV in unset, false);
  }
});

test("the setting reader fills missing and invalid fields with the defaults", () => {
  assert.deepEqual(bridgeTtlSetting({ main: "5m" }), { main: "5m", subagent: "5m" });
  assert.deepEqual(bridgeTtlSetting({ main: "2h", subagent: 7 }), DEFAULTS);
  for (const junk of ["1h", 3600, null, [], undefined]) assert.deepEqual(bridgeTtlSetting(junk), DEFAULTS);
});

test("derived TTL: 1h gives 3600, 5m gives 300, inherit and FORCE_PROMPT_CACHING_5M give null", () => {
  assert.equal(derivedBridgeTtlS(DEFAULTS, false, {}), 3600);
  assert.equal(derivedBridgeTtlS(DEFAULTS, true, {}), 300);
  assert.equal(derivedBridgeTtlS(bridgeTtlSetting({ main: "inherit" }), false, {}), null);
  assert.equal(derivedBridgeTtlS(DEFAULTS, false, { FORCE_PROMPT_CACHING_5M: "1" }), null);
  assert.equal(derivedBridgeTtlS(DEFAULTS, false, { FORCE_PROMPT_CACHING_5M: "0" }), 3600);
  assert.equal(forced5m({ FORCE_PROMPT_CACHING_5M: "true" }), true);
  assert.equal(forced5m({ FORCE_PROMPT_CACHING_5M: "" }), false);
  assert.equal(forced5m({}), false);
});
