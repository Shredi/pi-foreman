// Ledger item 26: `foreman setup` prints the no-review-model warning after a successful setup (bin/foreman runs
// scripts/foreman_review_warn.mjs); nothing when a review model is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_review_warn.mjs");

function warn(config, extra = []) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-review-warn-")));
  try {
    if (config) fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(config));
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, "--agent-dir", agentDir, ...extra], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

// r79 ledger item 10 wording: the review gate is the classifier; the config key keeps its name.
test("a provider with no classifier model prints the warning naming the config key", () => {
  const out = warn({ version: 1, providers: { fake: { roles: {} } } });
  assert.match(out, /^WARN no classifier model for provider fake: /m);
  assert.match(out, /providers\.<p>\.roles\.review\.model/);
});

test("no config at all prints the warning too", () => {
  assert.match(warn(null), /^WARN no classifier model for provider \(none\)/m);
});

test("a configured review model prints nothing", () => {
  assert.equal(warn({ version: 1, providers: { fake: { roles: { review: { model: "fake/m" } } } } }), "");
  assert.equal(warn({ version: 1, providers: { fake: { review: { model: "fake/m" } } } }), "");
});

test("--help prints nothing", () => {
  assert.equal(warn({ version: 1, providers: { fake: { roles: {} } } }, ["--help"]), "");
});
