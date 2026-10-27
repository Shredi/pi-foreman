import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { migrateGateConfig, gateLeftovers, REMOVED_REASON } = await import(pathToFileURL(path.join(HERE, "..", "..", "scripts", "foreman_migrate_gate.mjs")).href);

function fresh(config, { rendered = false } = {}) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-migrate-gate-")));
  const configPath = path.join(agentDir, "foreman.json");
  if (config) fs.writeFileSync(configPath, JSON.stringify(config));
  const renderedFile = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
  if (rendered) {
    fs.mkdirSync(path.dirname(renderedFile), { recursive: true });
    fs.writeFileSync(renderedFile, '{"rendered":true}');
  }
  return { agentDir, configPath, renderedFile, backup: path.join(agentDir, "pi-foreman", "state", "migration") };
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const old = () => ({
  review: { headless: true, childDefer: "owner", fallback: "x", critic: ["q"] },
  providers: { anthropic: { review: { model: "anthropic/claude-haiku-5-5", timeoutMs: 9000, extra: 1 } } },
  safety: { permissions: { autoReview: { rulesFile: "rules.md", enabled: true }, tools: { a: "allow" } }, keep: 1 },
});

test("each key is mapped or removed with one line", () => {
  const e = fresh(old());
  const seen = [];
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath, log: (l) => seen.push(l) });
  assert.equal(r.changed, true);
  assert.deepEqual(seen, r.lines);
  const cfg = read(e.configPath);
  assert.deepEqual(cfg, {
    review: { critic: ["q"] },
    providers: { anthropic: { roles: { review: { model: "anthropic/claude-haiku-5-5" } } } },
    gate: { reviewTimeoutMs: 9000, policy: { userFile: "rules.md" } },
    safety: { keep: 1 },
  });
  const text = r.lines.join("\n");
  assert.match(text, /providers\.anthropic\.review\.model: moved to providers\.anthropic\.roles\.review\.model/);
  assert.match(text, /providers\.anthropic\.review\.timeoutMs: moved to gate\.reviewTimeoutMs/);
  assert.match(text, /providers\.anthropic\.review\.extra: removed/);
  assert.match(text, /safety\.permissions\.autoReview\.rulesFile: moved to gate\.policy\.userFile/);
  for (const k of ["review.headless", "review.childDefer", "review.fallback", "safety.permissions.autoReview.enabled", "safety.permissions.tools.a"]) {
    assert.match(text, new RegExp(`${k.replace(/\./g, "\\.")}: removed`));
  }
  assert.ok(text.includes(REMOVED_REASON));
  for (const k of ["review.headless", "review.childDefer", "safety.permissions.tools.a"]) assert.equal(r.lines.filter((l) => l.includes(`${k}: `)).length, 1);
});

test("backup is written first, holds the old files, and the rendered config is moved", () => {
  const before = old();
  const e = fresh(before, { rendered: true });
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath });
  assert.equal(r.backupDir, e.backup);
  assert.deepEqual(read(path.join(e.backup, "foreman.json.pre-gate")), before);
  assert.equal(fs.readFileSync(path.join(e.backup, "permission-system-config.json"), "utf8"), '{"rendered":true}');
  assert.equal(fs.existsSync(e.renderedFile), false);
  // backup lines come before any key line
  const iBackup = r.lines.findIndex((l) => l.includes("pre-gate"));
  const iKey = r.lines.findIndex((l) => l.includes("review.headless"));
  assert.ok(iBackup >= 0 && iBackup < iKey);
});

test("restore steps name the previous release and the backup copy", () => {
  const e = fresh(old(), { rendered: true });
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath });
  const last = r.lines[r.lines.length - 1];
  assert.match(last, /install the previous pi-foreman release/);
  assert.ok(last.includes(path.join(e.backup, "foreman.json.pre-gate")));
  assert.ok(last.includes(path.join(e.backup, "permission-system-config.json")));
  assert.match(last, /rejects gate\.\* keys, so the backup copy is the way back/);
});

test("rendered config alone is moved without touching foreman.json", () => {
  const e = fresh({ keep: 1 }, { rendered: true });
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath });
  assert.equal(r.changed, true);
  assert.equal(fs.existsSync(path.join(e.backup, "foreman.json.pre-gate")), false);
  assert.equal(fs.existsSync(path.join(e.backup, "permission-system-config.json")), true);
  assert.deepEqual(read(e.configPath), { keep: 1 });
});

test("second run prints nothing and writes no second backup", () => {
  const e = fresh(old(), { rendered: true });
  migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath });
  const mtime = fs.statSync(path.join(e.backup, "foreman.json.pre-gate")).mtimeMs;
  const seen = [];
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath, log: (l) => seen.push(l) });
  assert.deepEqual(r, { lines: [], changed: false, backupDir: null });
  assert.deepEqual(seen, []);
  assert.equal(fs.statSync(path.join(e.backup, "foreman.json.pre-gate")).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(e.backup).sort(), ["foreman.json.pre-gate", "permission-system-config.json"]);
});

test("dry run prints the lines and writes nothing", () => {
  const before = old();
  const e = fresh(before, { rendered: true });
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath, dryRun: true });
  assert.ok(r.lines.length > 5);
  assert.ok(r.lines.some((l) => l.includes("would ")));
  assert.deepEqual(read(e.configPath), before);
  assert.equal(fs.existsSync(e.renderedFile), true);
  assert.equal(fs.existsSync(path.join(e.agentDir, "pi-foreman")), false);
});

test("a config without old keys and no rendered file is untouched", () => {
  const e = fresh({ keep: 1 });
  assert.deepEqual(migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath }), { lines: [], changed: false, backupDir: null });
  assert.equal(fs.existsSync(path.join(e.agentDir, "pi-foreman")), false);
});

test("an existing gate target is not overwritten", () => {
  const e = fresh({ gate: { policy: { userFile: "mine.md" } }, safety: { permissions: { autoReview: { rulesFile: "old.md" } } } });
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: e.configPath });
  assert.deepEqual(read(e.configPath), { gate: { policy: { userFile: "mine.md" } } });
  assert.match(r.lines.join("\n"), /safety\.permissions\.autoReview\.rulesFile: removed/);
});

test("gateLeftovers uses the setup texts and ignores providers.*.review", () => {
  const e = fresh(null, { rendered: true });
  const cfg = old();
  const left = gateLeftovers({ agentDir: e.agentDir, config: cfg });
  fs.mkdirSync(path.join(e.agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"), { recursive: true });
  const left2 = gateLeftovers({ agentDir: e.agentDir, config: cfg });
  assert.equal(left2.length, left.length + 1);
  assert.ok(!left.join("\n").includes("providers.anthropic"));
  const cp = path.join(e.agentDir, "foreman.json");
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const r = migrateGateConfig({ agentDir: e.agentDir, configPath: cp });
  for (const l of left.filter((x) => !x.startsWith("rendered"))) assert.ok(r.lines.includes(`gate migration: ${l}`), l);
  assert.ok(r.lines.includes(`gate migration: ${left.find((x) => x.startsWith("rendered"))}`));
  assert.deepEqual(gateLeftovers({ agentDir: e.agentDir, config: read(cp) }).length, 1); // only the package install remains
});
