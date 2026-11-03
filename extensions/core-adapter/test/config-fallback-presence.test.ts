// Ledger 18: a failed or timed-out config CLI falls back to the L1 defaults with presence forced off.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { get, loadMergedConfig } from "../config.ts";
import type { Spawner } from "../spawn.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const load = (spawner: Spawner, python: string | null = "py") =>
  loadMergedConfig({ python, pkgRoot: PKG, agentDir: "/nonexistent-agent", projectDir: "/nonexistent-project", trusted: false, spawner });

test("a timed-out config CLI: defaults, safetyFallback, presence off", async () => {
  const m = await load(async () => ({ code: null, stdout: "", stderr: "", timedOut: true }));
  assert.equal(m.source, "defaults");
  assert.equal(m.safetyFallback, true);
  assert.equal(get(m.config, "presence.enabled"), false);
  assert.equal(m.fallbackReason, "timed out");
});

test("unreadable CLI output and a missing Python also keep presence off", async () => {
  const bad = await load(async () => ({ code: 1, stdout: "nope", stderr: "", timedOut: false }));
  assert.equal(get(bad.config, "presence.enabled"), false);
  const none = await load(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), null);
  assert.equal(none.source, "defaults");
  assert.equal(get(none.config, "presence.enabled"), false);
});
