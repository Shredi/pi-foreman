// Ledger 11 (variants): an env-assignment prefix is seen by the owned-root pre-allow; one that changes npm's behaviour is not pre-allowed.
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

test("a child runs FOO=1 npm ci in its owned worktree root without an ask (decision: pass, the env prefix is seen)", () => {
  assert.equal(run(owned, "FOO=1 npm ci"), "pass");
});

test("a child runs FOO=1 BAR=2 npm ci in its owned worktree root without an ask (decision: pass, every env prefix is seen)", () => {
  assert.equal(run(owned, "FOO=1 BAR=2 npm ci"), "pass");
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
