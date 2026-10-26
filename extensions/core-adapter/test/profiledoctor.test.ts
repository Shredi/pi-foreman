import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { profileDoctorLines } from "../profiledoctor.ts";
import { loadDefaults } from "../profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const defaults = () => structuredClone(loadDefaults(ROOT)) as Record<string, unknown>;

test("no profile recorded: names the fix, no deviations line", () => {
  const cfg = defaults();
  assert.deepEqual(profileDoctorLines(cfg, cfg, ROOT), ["INFO profile: none (run foreman setup --pick or --profile <name>)"]);
});

test("an unknown profile warns with the valid names", () => {
  const cfg = { ...defaults(), profile: "nope" };
  const lines = profileDoctorLines(cfg, cfg, ROOT);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN profile nope unknown \(valid: orchestration, standard, full\)/);
});

test("standard on the defaults has no deviations; a hand-flipped toggle is named", () => {
  const cfg = { ...defaults(), profile: "standard" };
  assert.deepEqual(profileDoctorLines(cfg, cfg, ROOT), ["INFO profile: standard", "INFO profile deviations: none"]);
  const flipped = structuredClone(cfg) as unknown as { roles: { foreman: { codemode: boolean } } };
  flipped.roles.foreman.codemode = !flipped.roles.foreman.codemode;
  const lines = profileDoctorLines(flipped as never, flipped as never, ROOT);
  assert.match(lines[1], /^INFO profile deviations: codemode is (on|off), profile says (on|off)$/);
});

test("a relaxation that is on warns, with or without a profile", () => {
  const cfg = defaults() as { safety: { children: { mayPush: boolean } } };
  cfg.safety.children.mayPush = true;
  const lines = profileDoctorLines(cfg as never, cfg as never, ROOT);
  assert.ok(lines.includes("WARN safety relaxations on: children-may-push"), lines.join("\n"));
  assert.ok(!profileDoctorLines(defaults(), defaults(), ROOT).some((l) => l.startsWith("WARN safety")));
});
