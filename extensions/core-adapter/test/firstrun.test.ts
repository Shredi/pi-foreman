import { test } from "node:test";
import assert from "node:assert/strict";
import { firstRunNotice, providerGapNotice } from "../firstrun.ts";

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

const fitting = [{ name: "google", provider: "google" }, { name: "claude-bridge", provider: "claude-bridge" }, { name: "claude-bridge-sonnet-reviewer", provider: "claude-bridge" }];
const gapBase = { provider: "claude-bridge", config: { providers: {} } as unknown, presets: fitting, mode: "tui", isChild: false };

test("provider without a role map names the fitting presets", () => {
  const n = providerGapNotice(gapBase);
  assert.ok(n);
  assert.match(n, /no role map for provider claude-bridge/);
  assert.match(n, /Fitting presets: claude-bridge, claude-bridge-sonnet-reviewer \(foreman config apply-preset <name>\)/);
  assert.ok(providerGapNotice({ ...gapBase, mode: "rpc" }));
});

test("provider with no fitting preset points at providers.<id> and docs/roles.md", () => {
  const n = providerGapNotice({ ...gapBase, provider: "mistral" });
  assert.ok(n);
  assert.match(n, /Add providers\.mistral to foreman\.json \(see docs\/roles\.md\)/);
});

test("provider gap stays silent for a mapped provider, a child, no provider and print mode; quiet does not silence it", () => {
  assert.equal(providerGapNotice({ ...gapBase, config: { providers: { "claude-bridge": {} } } }), null);
  assert.equal(providerGapNotice({ ...gapBase, isChild: true }), null);
  assert.equal(providerGapNotice({ ...gapBase, provider: undefined }), null);
  assert.equal(providerGapNotice({ ...gapBase, mode: "print" }), null);
  assert.ok(providerGapNotice({ ...gapBase, config: { quiet: true } }));
});
