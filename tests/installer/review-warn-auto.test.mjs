// PR D3: `foreman setup` also warns when the classifier model is the cheapest role-map model, not a configured one.
import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "foreman_review_warn.mjs");

function warn(config) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-review-warn-auto-")));
  try {
    fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(config));
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, "--agent-dir", agentDir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("a provider whose classifier model falls back to the role map prints one WARN naming the model", () => {
  const out = warn({ version: 1, providers: { fake: { roles: { builder: { model: "fake/b" } } } } });
  assert.equal(out.trim().split("\n").length, 1, out);
  assert.match(out, /^WARN the classifier model for provider fake is fake\/b, the cheapest model of your role map/m);
  assert.match(out, /providers\.<p>\.roles\.review\.model/);
});

test("a configured classifier model prints nothing", () => {
  assert.equal(warn({ version: 1, providers: { fake: { roles: { builder: { model: "fake/b" }, review: { model: "fake/m" } } } } }), "");
});
