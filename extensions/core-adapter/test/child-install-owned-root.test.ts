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

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-child-own-install-")));
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

test("a child runs npm install / npm ci in its owned worktree root without an ask", () => {
  for (const cmd of ["npm install", "npm ci", "npm i", "npm ci --no-audit --no-fund", "npm install --prefix .", `npm ci --prefix=${bashPath(owned)}`]) assert.equal(run(owned, cmd), "pass", cmd);
});

test("a child still asks for npm install / ci with -g, a foreign --prefix, a package name or another option", () => {
  for (const cmd of ["npm install -g", "npm i -g left-pad", "npm ci --global", "npm install --prefix /elsewhere", `npm install --prefix ${other}`, "npm ci --prefix ..", "npm install left-pad", "npm ci --registry=http://x"]) assert.equal(run(owned, cmd), "ask", cmd);
});

test("a child still asks in a non-owned cwd or next to git fetch; a subdir of the owned root and a cd into it pass (R10 D2)", () => {
  assert.equal(run(other, "npm ci"), "ask");
  assert.equal(run(ws, "npm install"), "ask");
  assert.equal(run(path.join(owned, "sub"), "npm ci"), "pass"); // R10 item 6 (ruling D2): a subdir of the owned root is pre-allowed
  assert.equal(run(owned, "cd sub && npm ci"), "pass"); // R10 item 6 (ruling D2)
  assert.equal(run(owned, "npm ci && git fetch origin"), "ask");
});

test("git fetch stays an ask in the owned root", () => {
  assert.equal(run(owned, "git fetch origin"), "ask");
});
