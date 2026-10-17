import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownTaskReadable } from "../roundsurface.ts";
import { formatWaits, readAddonTasks } from "../bg.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-own-bg-")));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const own = path.join(ws, ".pi", "tasks", "sess-own-4321");
const foreign = path.join(ws, ".pi", "tasks", "sess-other-99");
for (const d of [own, foreign, ag]) fs.mkdirSync(d, { recursive: true });

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ownTasks = ownTaskReadable([ws], "sess-own", process.platform);
const ctx = (role: "main" | "child", withOwn = true): MatchCtx => ({ cwd: ws, home, platform: process.platform, role, ...(withOwn ? { ownTasks } : {}) });
const sh = (role: "main" | "child", command: string, withOwn = true): string => checkToolCall(rules, "bash", { command }, ctx(role, withOwn))?.kind ?? "pass";
const rd = (role: "main" | "child", p: string): string => checkToolCall(rules, "read", { path: p }, ctx(role))?.kind ?? "pass";

test("the session's own bg_run task dir is readable by bash and the read tool, for the session and a child", () => {
  for (const role of ["main", "child"] as const) {
    assert.equal(sh(role, "cat .pi/tasks/sess-own-4321/t1.output"), "pass", role);
    assert.equal(sh(role, "tail -n 20 .pi/tasks/sess-own-4321/t1.output"), "pass", role);
    assert.equal(sh(role, "grep -n error .pi/tasks/sess-own-4321/t1.output"), "pass", role);
    assert.equal(rd(role, path.join(own, "t1.output")), "pass", role);
  }
});

test("a child's bash read of the own task dir was denied without the pattern (the fix is the pattern)", () => {
  assert.equal(sh("child", "cat .pi/tasks/sess-own-4321/t1.output", false), "deny");
});

test("another session's task dir stays protected for a child, and the own pattern does not leak to a prefix id", () => {
  assert.equal(sh("child", "cat .pi/tasks/sess-other-99/t1.output"), "deny");
  assert.equal(sh("child", "cat .pi/tasks/sess-own2-1/t1.output"), "deny");
  assert.equal(sh("child", "cat .pi/tasks/sess-own/t1.output"), "deny");
  assert.deepEqual(ownTaskReadable([ws], "", process.platform), []);
});

test("a symlink in the own task dir that leads to a protected path, or a .. escape, stays protected", { skip: process.platform === "win32" }, () => {
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  fs.symlinkSync(path.join(ws, ".git"), path.join(own, "gitlink"));
  assert.equal(sh("child", "cat .pi/tasks/sess-own-4321/gitlink/config"), "deny");
  assert.equal(sh("child", "cat .pi/tasks/sess-own-4321/../../settings.json"), "deny");
});

test("writes into the own task dir stay denied for a child", () => {
  assert.notEqual(sh("child", "rm .pi/tasks/sess-own-4321/t1.output"), "pass");
  assert.notEqual(sh("child", "echo x > .pi/tasks/sess-own-4321/t1.output"), "pass");
});

test("bg_status, bg_logs and bg_kill carry a tool-level allow in the baseline (no permission dialog)", () => {
  const tools = (JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { tools: Record<string, string> }).tools;
  for (const t of ["bg_status", "bg_logs", "bg_kill", "bg_wait"]) assert.equal(tools[t], "allow", t);
});

test("readAddonTasks offers the output path relative to the worktree, and /foreman waits prints it", () => {
  fs.writeFileSync(path.join(own, "t1.json"), JSON.stringify({ id: "t1", command: "x", status: "running", startTime: Date.now(), outputPath: path.join(".pi", "tasks", "sess-own-4321", "t1.output") }));
  fs.writeFileSync(path.join(own, "t1.output"), "a\nb\n");
  const t = readAddonTasks(ws).find((x) => x.id === "t1")!;
  assert.equal(t.log, ".pi/tasks/sess-own-4321/t1.output");
  assert.match(formatWaits([], [t]), /\n  \| b\n  log \.pi\/tasks\/sess-own-4321\/t1\.output$/);
});
