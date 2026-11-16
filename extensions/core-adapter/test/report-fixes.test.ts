// Small report fixes: size text (D8), ledger mark text (D9), idle cache not dormant by default (D4), deferred doctor lines (D2).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { addedPatterns, deferredDoctorLines } from "../deferred.ts";
import { dormantFeatures, withBuiltinKeepalive } from "../features.ts";
import type { FeatureMap } from "../features.ts";
import { resolveCachePolicy } from "../cachepolicy.ts";
import { TOP_LEVEL_NOTE, takeSizing } from "../sizing.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

test("D8: the size text shows files as a list of paths; a number stays refused", () => {
  assert.ok(TOP_LEVEL_NOTE.includes('size: {files: ["path", ...], largestFileLines?, modules?}'));
  assert.ok(read("instructions", "foreman.md").includes('size: {files: ["path", ...], largestFileLines?, modules?}'));
  for (const files of [3, "a.ts"]) {
    const t = takeSizing({ agent: "builder", task: "x", size: { files } });
    assert.match(t.error ?? "", /\[sizing_invalid\]/, String(files));
  }
});

test("D9: the foreman_ledger description says a mark's note goes to every marked item", () => {
  assert.ok(read("extensions", "core-adapter", "index.ts").includes("mark: an optional note, given to every marked item."));
});

const MAP = JSON.parse(read("config", "features.json")) as FeatureMap;
const dormant = (config: unknown, provider: string, model?: string) => dormantFeatures(MAP, withBuiltinKeepalive(config, provider, resolveCachePolicy(config, provider, model, 300).active));

test("D4: a built-in provider with no config does not list idle-cache as dormant", () => {
  assert.equal(resolveCachePolicy({}, "claude-bridge", undefined, 300).active, true);
  assert.equal(dormant({}, "claude-bridge").includes("idle-cache"), false);
  assert.equal(dormant({ providers: { "claude-bridge": { cache: { ttlSeconds: 300 } } } }, "claude-bridge").includes("idle-cache"), false);
});

test("D4: an explicit keepalive.enabled false keeps it dormant", () => {
  const cfg = { providers: { "claude-bridge": { cache: { keepalive: { enabled: false } } } } };
  assert.equal(dormant(cfg, "claude-bridge").includes("idle-cache"), true);
});

test("D4: a provider outside the built-in table with no config stays dormant", () => {
  assert.equal(resolveCachePolicy({}, "acme", undefined, 300).active, false);
  assert.equal(dormant({}, "acme").includes("idle-cache"), true);
});

test("D4: the config passed in is not changed", () => {
  const cfg = { providers: { "claude-bridge": { cache: { ttlSeconds: 300 } } } };
  withBuiltinKeepalive(cfg, "claude-bridge", true);
  assert.deepEqual(cfg, { providers: { "claude-bridge": { cache: { ttlSeconds: 300 } } } });
});

test("D2: an unmatched shipped default pattern gives no line, a user-added one still warns", () => {
  const shipped = (JSON.parse(read("config", "foreman.defaults.json")) as { tools: { deferred: string[] } }).tools.deferred;
  assert.ok(shipped.length > 0);
  const merged = [...shipped, "my_tool"];
  const lines = deferredDoctorLines(addedPatterns(merged, shipped), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"my_tool" matches no registered tool/);
  assert.deepEqual(deferredDoctorLines(addedPatterns(shipped, shipped), []), []);
});
