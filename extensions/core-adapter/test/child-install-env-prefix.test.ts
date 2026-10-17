// Ledger 11 (variants): an env-assignment prefix is seen by the owned-root pre-allow; any env prefix loses the pre-allow (fail closed).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { bashPath } from "./_bashpath.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-child-env-install-")));
const ws = path.join(w, "ws");
const owned = path.join(w, "ws.worktrees", "r1");
const other = path.join(w, "other");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, owned, other, path.join(owned, "sub"), ag]) fs.mkdirSync(d, { recursive: true });

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const run = (cwd: string, command: string): string => {
  const ctx: MatchCtx = { cwd, home, platform: process.platform, role: "child", roundRoots: [owned] };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};

test("a child runs npm ci in its owned worktree root without an ask (decision: pass, no env prefix)", () => {
  assert.equal(run(owned, "npm ci"), "pass");
});

test("a child asks for FOO=1 npm ci in its owned worktree root: any env prefix loses the pre-allow (decision: ask)", () => {
  assert.equal(run(owned, "FOO=1 npm ci"), "ask");
});

test("a child asks for FOO=1 BAR=2 npm ci in its owned worktree root: any env prefix loses the pre-allow (decision: ask)", () => {
  assert.equal(run(owned, "FOO=1 BAR=2 npm ci"), "ask");
});

test("a child asks for COMSPEC=x npm ci in its owned root: an unlisted env name still loses the pre-allow (decision: ask)", () => {
  assert.equal(run(owned, "COMSPEC=x npm ci"), "ask");
});

test("a child asks for CC=x npm ci in its owned root: an unlisted env name still loses the pre-allow (decision: ask)", () => {
  assert.equal(run(owned, "CC=x npm ci"), "ask");
});

test("a child asks for npm_config_prefix=/elsewhere npm ci in its owned root: no owned-root pre-allow for a behaviour-changing env prefix (decision: ask)", () => {
  assert.equal(run(owned, "npm_config_prefix=/elsewhere npm ci"), "ask");
});

test("a child asks for PATH=/elsewhere npm ci in its owned root: no owned-root pre-allow for PATH (decision: ask)", () => {
  assert.equal(run(owned, "PATH=/elsewhere npm ci"), "ask");
});

test("a child asks for FOO=1 npm_config_prefix=/elsewhere npm ci: one behaviour-changing env prefix among harmless ones loses the pre-allow (decision: ask)", () => {
  assert.equal(run(owned, "FOO=1 npm_config_prefix=/elsewhere npm ci"), "ask");
});

test("a child asks for FOO=1 npm ci with a foreign --prefix: an env prefix does not widen the --prefix rule (decision: ask)", () => {
  assert.equal(run(owned, `FOO=1 npm ci --prefix=${bashPath(other)}`), "ask");
});

test("a child asks for FOO=1 npm ci in a non-owned cwd: an env prefix does not widen the cwd rule (decision: ask)", () => {
  assert.equal(run(other, "FOO=1 npm ci"), "ask");
});

// Fail-open gap: variants() strips `env -i` and a separate `export` unit is not seen, so these pass today; the fix is a later item.
test("expected-open (R10): env -i npm ci", () => {
  assert.equal(run(owned, "env -i npm ci"), "pass");
});

// Fail-open gap: a separate `export` unit is not seen by the owned-root pre-allow, so this passes today; the fix is a later item.
test("expected-open (R10): export npm_config_prefix=<OWNED>/x; npm ci", () => {
  assert.equal(run(owned, `export npm_config_prefix=${bashPath(path.join(owned, "x"))}; npm ci`), "pass");
});
