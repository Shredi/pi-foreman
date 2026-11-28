// The subscription presets (github-copilot, openai-codex) and the shipped openai preset: doctor's rank check is empty for each documented
// foreman model, and the rank policy allows each role's normal and strong model under that foreman (the reviewer pair is not a rank check).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { rankDoctorFindings, rankRefusalFor } from "../ranks.ts";

const PRESET = (name: string): Record<string, any> => JSON.parse(fs.readFileSync(new URL(`../../../config/presets/${name}.json`, import.meta.url), "utf8"));

const CASES: [string, string, string][] = [
  ["github-copilot", "github-copilot", "github-copilot/claude-opus-5.5"],
  ["github-copilot", "github-copilot", "github-copilot/claude-sonnet-5.5"],
  ["openai-codex", "openai-codex", "openai-codex/gpt-6-astra"],
  ["openai", "openai", "openai/gpt-6-astra"],
];

for (const [preset, provider, foreman] of CASES) {
  test(`${preset} under ${foreman}: doctor's rank check is empty`, () => {
    const config = PRESET(preset);
    assert.deepEqual(rankDoctorFindings(config, foreman, config.providers[provider].roles), []);
  });

  test(`${preset} under ${foreman}: builder and explorer, normal and strong models, are launchable`, () => {
    const config = PRESET(preset);
    const roles = config.providers[provider].roles;
    for (const role of ["builder", "explorer"]) {
      assert.equal(rankRefusalFor(config, foreman, roles[role].model, [role]), null, `${role} normal`);
      assert.equal(rankRefusalFor(config, foreman, roles[role].strong.model, [role]), null, `${role} strong`);
    }
  });
}

test("github-copilot under the Sonnet foreman: the reviewer's mapped Sol is launchable at or below the foreman", () => {
  const config = PRESET("github-copilot");
  assert.equal(rankRefusalFor(config, "github-copilot/claude-sonnet-5.5", "github-copilot/gpt-6.1-sol", ["reviewer"]), null);
});
