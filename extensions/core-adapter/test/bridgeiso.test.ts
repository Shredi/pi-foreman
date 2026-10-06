import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BridgeIsolation, isolationDir, isolationDoctor, isolationOn, keychainService, projectClaudeRisks } from "../bridgeiso.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pf-iso-"));

test("auto follows the provider; booleans win", () => {
  assert.equal(isolationOn("auto", "claude-bridge"), true);
  assert.equal(isolationOn("auto", "other"), false);
  assert.equal(isolationOn(undefined, "claude-bridge"), true);
  assert.equal(isolationOn(false, "claude-bridge"), false);
  assert.equal(isolationOn(true, "other"), true);
});

test("env is set to an empty 0700 folder and restored on a provider switch or when off", () => {
  const agent = tmp();
  const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: "/prev" };
  const iso = new BridgeIsolation();
  const dir = iso.apply(env, agent, "auto", "claude-bridge");
  assert.equal(dir, isolationDir(agent));
  assert.equal(env.CLAUDE_CONFIG_DIR, dir);
  assert.deepEqual(fs.readdirSync(dir!), []);
  if (process.platform !== "win32") assert.equal(fs.statSync(dir!).mode & 0o777, 0o700);
  iso.apply(env, agent, "auto", "claude-bridge");
  assert.equal(iso.apply(env, agent, "auto", "other"), null);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/prev");
  iso.apply(env, agent, true, "other");
  assert.equal(env.CLAUDE_CONFIG_DIR, dir);
  iso.apply(env, agent, false, "claude-bridge");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/prev");
  const bare: Record<string, string | undefined> = {};
  new BridgeIsolation().apply(bare, agent, "auto", "other");
  assert.equal("CLAUDE_CONFIG_DIR" in bare, false);
  const unset: Record<string, string | undefined> = {};
  const iso2 = new BridgeIsolation();
  iso2.apply(unset, agent, "auto", "claude-bridge");
  iso2.apply(unset, agent, "auto", "other");
  assert.equal("CLAUDE_CONFIG_DIR" in unset, false);
});

test("doctor fails on host config entries and reports login presence without values", () => {
  const dir = tmp();
  const lines = isolationDoctor({ dir, env: {}, platform: "linux" });
  assert.match(lines[0], /^OK/);
  assert.match(lines[1], /^WARN bridge login not found/);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ hooks: {} }));
  fs.mkdirSync(path.join(dir, "plugins", "cache", "x"), { recursive: true });
  const bad = isolationDoctor({ dir, env: { CLAUDE_CODE_OAUTH_TOKEN: "sekrit-token" }, platform: "linux" });
  assert.match(bad[0], /^FAIL .*settings\.json: hooks, plugins\//);
  assert.match(bad[1], /CLAUDE_CODE_OAUTH_TOKEN set/);
  assert.equal(bad.join("\n").includes("sekrit-token"), false);
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
  assert.match(isolationDoctor({ dir, env: {}, platform: "linux" })[1], /credentials file/);
});

test("doctor probes the keychain service for the folder on macOS only", () => {
  const dir = tmp();
  const seen: string[] = [];
  const probe = (svc: string): boolean => (seen.push(svc), true);
  assert.match(isolationDoctor({ dir, env: {}, platform: "darwin", keychain: probe })[1], /keychain entry/);
  assert.deepEqual(seen, [keychainService(dir)]);
  assert.match(keychainService(dir), /^Claude Code-credentials-[0-9a-f]{8}$/);
  isolationDoctor({ dir, env: {}, platform: "linux", keychain: probe });
  assert.equal(seen.length, 1);
});

test("M2: every command-running settings key is a project finding", () => {
  const p = tmp();
  fs.mkdirSync(path.join(p, ".claude"));
  fs.writeFileSync(path.join(p, ".claude", "settings.json"), JSON.stringify({ awsAuthRefresh: "x", awsCredentialExport: "x", otelHeadersHelper: "x", gcpAuthRefresh: "x", proxyAuthHelper: "x", statusLine: {}, env: {}, enabledPlugins: {}, extraKnownMarketplaces: {}, model: "m" }));
  assert.deepEqual(projectClaudeRisks(p), [".claude/settings.json (awsAuthRefresh, awsCredentialExport, gcpAuthRefresh, otelHeadersHelper, proxyAuthHelper, statusLine, env, enabledPlugins, extraKnownMarketplaces)"]);
  fs.rmSync(p, { recursive: true, force: true });
});

test("doctor judges settings and plugins by content, not existence", () => {
  const fails = (dir: string) => isolationDoctor({ dir, env: {}, platform: "linux" })[0].startsWith("FAIL");
  const d = tmp();
  fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.equal(fails(d), false);
  assert.ok(isolationDoctor({ dir: d, env: {}, platform: "linux" }).some((l) => l.startsWith("INFO") && l.includes("theme")));
  fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ theme: "dark", hooks: {} }));
  assert.equal(fails(d), true);
  fs.writeFileSync(path.join(d, "settings.json"), "{ nope");
  assert.equal(fails(d), true);
  const m = tmp();
  fs.mkdirSync(path.join(m, "plugins", "marketplaces"), { recursive: true });
  fs.writeFileSync(path.join(m, "plugins", "known_marketplaces.json"), "{}");
  fs.writeFileSync(path.join(m, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  assert.equal(fails(m), false);
  fs.writeFileSync(path.join(m, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "x@y": [{ scope: "user" }] } }));
  assert.equal(fails(m), true);
});
