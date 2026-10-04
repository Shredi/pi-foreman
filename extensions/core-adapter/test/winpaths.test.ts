// Security re-check M1: Win32 path normalisation in the write protection. Trailing dots and
// spaces are stripped per segment; an 8.3 short-name segment is read as the protected name it
// could abbreviate, but only where that name sits. Simulated win32 runs on every host; the last
// test runs on the Windows CI job only and uses the real file system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline, shortNameFits } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = buildOverlayRules(baseline, {}, {}, "C:\\Profiles\\u\\.pi\\agent");
const wctx = (role: "main" | "child"): MatchCtx => ({ cwd: "C:\\w\\proj", home: "C:\\Profiles\\u", platform: "win32", role, exists: () => false, isDir: () => false, realpath: () => null, list: () => [] });
const both = (tool: string, input: Record<string, unknown>): string => ["main", "child"].map((r) => checkToolCall(w, tool, input, wctx(r as "main" | "child"))?.kind ?? "pass").join("/");

test("win32: trailing dots and spaces in a segment do not hide a protected path", () => {
  assert.equal(both("write", { path: ".git.\\config" }), "deny/deny");
  assert.equal(both("write", { path: ".claude.\\settings.json" }), "ask/deny");
  assert.equal(both("write", { path: ".claude. .\\settings.json" }), "ask/deny");
  assert.equal(both("write", { path: ".mcp.json." }), "ask/deny");
  assert.equal(both("bash", { command: "echo x > .claude./settings.json" }), "ask/deny");
  assert.equal(both("powershell", { command: "Set-Content -Path .git.\\config -Value x" }), "deny/deny");
  assert.equal(both("bash", { command: "cat ~/.ssh./id_ed25519" }), "deny/deny", "deny paths are normalised too");
  assert.equal(both("write", { path: "notes.\\x.txt" }), "pass/pass");
});

test("win32: an 8.3 short name where a protected name sits is asked (foreman) / denied (child)", () => {
  assert.equal(both("write", { path: "CLAUDE~1\\settings.json" }), "ask/deny");
  assert.equal(both("bash", { command: "echo x > claude~1/settings.local.json" }), "ask/deny");
  assert.equal(both("write", { path: "MCP~1.JSO" }), "ask/deny");
  assert.equal(both("write", { path: "C:\\Profiles\\u\\PI~1\\agent\\settings.json" }), "ask/deny");
  assert.equal(both("write", { path: "C:\\Profiles\\u\\CL4F2A~5\\settings.json" }), "ask/deny", "hash form");
  assert.equal(both("write", { path: "GIT~1\\config" }), "deny/deny", ".git stays denied in every session");
  const r = checkToolCall(w, "write", { path: "CLAUDE~1\\settings.json" }, wctx("main"));
  assert.match(r!.reason, /8\.3 short name/);
});

test("win32: an 8.3 short name of a deny-path folder is denied", () => {
  assert.equal(both("bash", { command: "cat ~\\SSH~1\\id_ed25519" }), "deny/deny");
  assert.equal(both("read", { path: "C:\\Profiles\\u\\AWS~1\\config" }), "deny/deny");
  assert.equal(both("read", { path: "C:\\Profiles\\u\\DOCUME~1\\x.txt" }), "pass/pass");
});

test("win32: short names elsewhere change nothing", () => {
  assert.equal(both("write", { path: "C:\\PROGRA~1\\app\\settings.json" }), "pass/pass");
  assert.equal(both("write", { path: "PROGRA~1\\x.txt" }), "pass/pass", "does not fit a protected name");
  assert.equal(both("write", { path: "docs\\CLAUDE~1\\settings.json" }), "pass/pass", "not where .claude sits");
  assert.equal(both("write", { path: "C:\\Profiles\\u\\PI~1\\other.txt" }), "pass/pass", "the rest of the path must match too");
  assert.equal(both("write", { path: "GITHUB~1\\workflows\\ci.yml" }), "pass/pass");
  assert.equal(shortNameFits("CLAUDE~1", ".claude"), true);
  assert.equal(shortNameFits("MCP~1.JSO", ".mcp.json"), true);
  assert.equal(shortNameFits("GIT~1", ".github"), false);
});

test("win32 host: real trailing-dot and short-name spellings reach the protected folder and are caught", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-win-")));
  try {
    const cwd = path.join(root, "proj");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const rules = buildOverlayRules(baseline, {}, {}, path.join(root, "home", ".pi", "agent"));
    const ctx = (role: "main" | "child"): MatchCtx => ({ cwd, home: path.join(root, "home"), platform: "win32", role });
    const k = (p: string): string => ["main", "child"].map((r) => checkToolCall(rules, "write", { path: p }, ctx(r as "main" | "child"))?.kind ?? "pass").join("/");
    // The overlay must catch the trailing-dot spelling whatever the file API does with it.
    assert.equal(k(path.join(cwd, ".claude.", "settings.json")), "ask/deny");
    assert.equal(k(path.join(cwd, ".claude", "settings.json.")), "ask/deny");
    // On the CI runners Win32 rejects a trailing dot on a middle segment ("syntax is incorrect")
    // but strips it from the last one, so the real-disk probe uses the last segment. Node's fs
    // keeps the dot (ENOENT), so cmd writes the probe.
    execFileSync("cmd", ["/d", "/c", `echo x> "${path.join(cwd, ".claude", "probe.txt.")}"`]);
    assert.ok(fs.existsSync(path.join(cwd, ".claude", "probe.txt")), "Win32 strips the trailing dot of the last segment");
    const short = execFileSync("cmd", ["/d", "/c", `for %I in ("${path.join(cwd, ".claude")}") do @echo %~sI`], { encoding: "utf8" }).trim();
    const name = path.basename(short);
    if (!name.includes("~")) {
      t.diagnostic("8.3 names are off on this volume; short-name part skipped");
      return;
    }
    assert.ok(fs.existsSync(path.join(cwd, name, "probe.txt")), "the short name reaches the same folder");
    assert.equal(k(path.join(cwd, name, "settings.json")), "ask/deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
