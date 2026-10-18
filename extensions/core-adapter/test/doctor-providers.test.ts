// /foreman doctor: the `providers:` line (R14 item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { providersLine } from "../bridgeiso.ts";

test("doctor_providers_line_lists_registered_providers_sorted_unique", () => {
  const reg = { getAll: () => [{ provider: "openai" }, { provider: "claude-bridge" }, { provider: "openai" }, { provider: "anthropic" }] };
  assert.equal(providersLine(reg), "providers: anthropic, claude-bridge, openai");
});

test("doctor_providers_line_survives_a_missing_or_throwing_registry", () => {
  assert.equal(providersLine({}), "providers: (none)");
  assert.equal(providersLine({ getAll: () => { throw new Error("x"); } }), "providers: (none)");
});
