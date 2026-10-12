import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-child-ask-")));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, ag]) fs.mkdirSync(d, { recursive: true });

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const world = (role: "main" | "child"): MatchCtx => ({ cwd: ws, home, platform: process.platform, role });
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules, "bash", { command }, world(role))?.kind ?? "pass";

test("a child asks for npm ci, npm install and git fetch; the foreman keeps the rows", () => {
  for (const cmd of ["npm ci", "npm install", "npm i", "git fetch origin", "git -C . fetch", "cd x && npm ci"]) {
    assert.equal(sh("child", cmd), "ask", cmd);
    assert.equal(sh("main", cmd), "pass", `foreman: ${cmd}`);
  }
});

test("other npm and git commands are untouched for a child", () => {
  for (const cmd of ["npm test", "npm run typecheck", "git status", "git log --oneline"]) assert.notEqual(sh("child", cmd), "ask", cmd);
});
