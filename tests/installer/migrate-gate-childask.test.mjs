import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { migrateGateConfig } = await import(pathToFileURL(path.join(HERE, "..", "..", "scripts", "foreman_migrate_gate.mjs")).href);

function run(config) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-migrate-childask-")));
  const configPath = path.join(agentDir, "foreman.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const r = migrateGateConfig({ agentDir, configPath });
  return { lines: r.lines, cfg: JSON.parse(fs.readFileSync(configPath, "utf8")) };
}

test("review.childDefer owner maps to gate.childAsk parent, one line", () => {
  const { lines, cfg } = run({ review: { childDefer: "owner" } });
  assert.deepEqual(cfg, { gate: { childAsk: "parent" } });
  assert.equal(lines.filter((l) => l.includes("review.childDefer")).length, 1);
});

test("any other review.childDefer value maps to gate.childAsk deny", () => {
  for (const v of ["deny", "none", "", 7]) assert.deepEqual(run({ review: { childDefer: v } }).cfg, { gate: { childAsk: "deny" } }, String(v));
});

test("an existing gate.childAsk wins; review.childDefer is removed with the reason", () => {
  const { lines, cfg } = run({ gate: { childAsk: "deny" }, review: { childDefer: "owner" } });
  assert.deepEqual(cfg, { gate: { childAsk: "deny" } });
  assert.match(lines.join("\n"), /review\.childDefer: removed \(gate\.childAsk is already set\)/);
});

test("review.headless and review.fallback are removed with their reasons", () => {
  const { lines } = run({ review: { headless: true, fallback: "x" } });
  const text = lines.join("\n");
  assert.match(text, /review\.headless: removed \(a session with no pane above it denies an ask\)/);
  assert.match(text, /review\.fallback: removed \(nothing reads it\)/);
});
