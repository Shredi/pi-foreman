// The project verify skill verifying-review-gates loads through Pi's loader and names files that exist.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR = path.join(REPO, ".agents", "skills");

test("verifying-review-gates loads with no diagnostics, names its trigger phrases and every path it lists exists", () => {
  const tmp = fs.realpathSync(mkTestTmp("verify-review-gates-"));
  try {
    const r = loadSkills({ cwd: tmp, agentDir: path.join(tmp, "agent"), skillPaths: [DIR], includeDefaults: false });
    assert.deepEqual(r.diagnostics, []);
    const skill = r.skills.find((s) => s.name === "verifying-review-gates");
    assert.ok(skill, JSON.stringify(r.skills.map((s) => s.name)));
    assert.ok(skill.description.length <= 1024);
    for (const phrase of ["'verify the review gates'", "'rerun the review gate check'", "'sweep the review gate seeds'"]) assert.ok(skill.description.includes(phrase), phrase);
    const text = fs.readFileSync(path.join(DIR, "verifying-review-gates", "SKILL.md"), "utf8");
    const named = [...text.matchAll(/`((?:extensions|scripts|docs)\/[^`\s]+\.(?:ts|mjs|md|py))`/g)].map((m) => m[1]);
    assert.ok(named.length >= 4, String(named.length));
    for (const f of named) assert.ok(fs.existsSync(path.join(REPO, f)), `${f} exists`);
    assert.ok(named.includes("extensions/core-adapter/test/review-gates-generator.test.ts"));
    for (const h of ["Rule", "Harm", "Tool and why", "Covered", "Left out", "Rerun", "Seen failing", "Reading a failure", "After an intended change"]) assert.ok(text.includes(`## ${h}`), h);
  } finally {
    rmTestTmp(tmp);
  }
});
