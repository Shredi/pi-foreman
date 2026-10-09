import { test } from "node:test";
import assert from "node:assert/strict";
import { firstRunNotice } from "../firstrun.ts";

const presets = ["google", "openai"];
const base = { mode: "tui", isChild: false, config: { providers: {} } as unknown, presets };

test("unconfigured interactive top-level session gets the notice with presets and command", () => {
  const n = firstRunNotice(base);
  assert.ok(n);
  assert.match(n, /google, openai/);
  assert.match(n, /foreman config apply-preset <name> \[--foreman <model id>\]/);
});

test("a role model or a review model counts as configured", () => {
  assert.equal(firstRunNotice({ ...base, config: { providers: { p: { roles: { builder: { model: "p/m" } } } } } }), null);
  assert.equal(firstRunNotice({ ...base, config: { providers: { p: { review: { model: "p/m" } } } } }), null);
  assert.ok(firstRunNotice({ ...base, config: { providers: { p: { costTier: 1, roles: { builder: { thinking: "low" } } } } } }));
});

test("quiet, non-tui modes and child sessions stay silent", () => {
  assert.equal(firstRunNotice({ ...base, config: { quiet: true } }), null);
  for (const mode of ["rpc", "print", "json", undefined]) assert.equal(firstRunNotice({ ...base, mode }), null);
  assert.equal(firstRunNotice({ ...base, isChild: true }), null);
});
