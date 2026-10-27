import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateMigrationLines } from "../gatemigrate.ts";
import { migrateGateConfig } from "../../../scripts/foreman_migrate_gate.mjs";

function agent(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-gate-doctor-"));
}

test("clean config: no lines", () => {
  assert.deepEqual(gateMigrationLines({ agentDir: agent(), config: { review: { critic: [] }, providers: { a: { review: { model: "m" } } } } }), []);
});

test("leftover keys, rendered config and package install each FAIL with the setup text", () => {
  const agentDir = agent();
  const configPath = path.join(agentDir, "foreman.json");
  const config = { review: { headless: true, childDefer: "owner" }, safety: { permissions: { tools: { a: "allow" } } } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const rendered = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
  fs.mkdirSync(path.dirname(rendered), { recursive: true });
  fs.writeFileSync(rendered, "{}");
  fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"), { recursive: true });
  const lines = gateMigrationLines({ agentDir, config });
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.startsWith("FAIL ") && l.includes("— fix: run foreman setup")));
  assert.ok(lines.some((l) => l.includes("review.headless: removed")));
  assert.ok(lines.some((l) => l.includes("permission package install")));
  const setup = migrateGateConfig({ agentDir, configPath }).lines;
  for (const l of lines.filter((x) => !x.includes("package install"))) {
    const text = l.slice("FAIL ".length, l.indexOf(" — fix:"));
    assert.ok(setup.includes(`gate migration: ${text}`), text);
  }
  assert.equal(gateMigrationLines({ agentDir, config: JSON.parse(fs.readFileSync(configPath, "utf8")) }).length, 1);
});
