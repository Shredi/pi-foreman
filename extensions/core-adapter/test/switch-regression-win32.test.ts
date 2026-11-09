// Item 5 regression: a Windows-native `/switch` word (`/getConnectState`, `/in:x`) is no path. It must not ask; a secret behind a switch still denies.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const rules = buildOverlayRules(baseline, {}, {}, "C:\\Profiles\\u\\.pi\\agent");
const wctx = (role: "main" | "child"): MatchCtx => ({ cwd: "C:\\w\\proj", home: "C:\\Profiles\\u", platform: "win32", role, exists: () => false, isDir: () => false, realpath: () => null, list: () => [] });
const kind = (command: string, role: "main" | "child" = "main"): string => checkToolCall(rules, "bash", { command }, wctx(role))?.kind ?? "pass";

test("win32: switch words are not paths (no ask, no deny)", () => {
  for (const c of ["tool.exe /getConnectState", "tool.exe /switch", "dsregcmd /status", "ipconfig /all", "tasklist /fi \"imagename eq node.exe\""]) {
    for (const role of ["main", "child"] as const) assert.equal(kind(c, role), "pass", `${role}: ${c}`);
  }
});

test("win32: a secret behind a switch still denies", () => {
  assert.equal(kind("findstr /in:C:/Profiles/u/.ssh/id_ed25519 x"), "deny");
  assert.equal(kind("tool.exe /in:C:\\Profiles\\u\\.ssh\\id_ed25519"), "deny");
});
