// R46 item 10(a): renaming or moving the current session dir, or an ancestor up to {agentDir}/sessions, asks for the
// foreman and is denied for a child (removeAsk), via shell mv and foreman_move. Writes below the dir still pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-sdmove-")));
const cwd = path.join(root, "proj");
const agentDir = path.join(root, "home", ".pi", "agent");
const sessions = path.join(agentDir, "sessions");
const outer = path.join(sessions, "--proj--");
const sessionDir = path.join(outer, "sub");
const art = path.join(sessionDir, "subagent-artifacts");
for (const d of [cwd, agentDir, art]) fs.mkdirSync(d, { recursive: true });

const guarded = buildOverlayRules(baseline, {}, {}, agentDir, path.join(root, "pkg"), undefined, false, undefined, [], sessionDir);
const plain = buildOverlayRules(baseline, {}, {}, agentDir, path.join(root, "pkg"));
const ctx = (role: "main" | "child"): MatchCtx => ({ cwd, home: path.join(root, "home"), platform: process.platform, role });
const kind = (rules: typeof guarded, tool: string, input: Record<string, unknown>, role: "main" | "child"): string => checkToolCall(rules, tool, input, ctx(role))?.kind ?? "pass";
const want = (role: "main" | "child"): string => (role === "main" ? "ask" : "deny");

test("session dir and its ancestors up to sessions: mv and foreman_move ask (foreman) / deny (child)", () => {
  for (const dir of [sessionDir, outer, sessions]) {
    for (const role of ["main", "child"] as const) {
      const calls: [string, Record<string, unknown>][] = [
        ["bash", { command: `mv ${dir} ${dir}.old` }],
        ["bash", { command: `mv ${dir} ${path.join(cwd, "elsewhere")}` }],
        ["foreman_move", { src: dir, dst: `${dir}.old` }],
        ["foreman_move", { src: dir, dst: path.join(cwd, "elsewhere") }],
      ];
      for (const [tool, input] of calls) {
        assert.equal(kind(guarded, tool, input, role), want(role), `${role}: ${tool} ${JSON.stringify(input)}`);
      }
    }
  }
  // without the session dir the session dir itself is not asked (the test fails without the rule)
  assert.equal(kind(plain, "foreman_move", { src: sessionDir, dst: `${sessionDir}.old` }, "main"), "pass");
});

test("session dir: writes below it and sibling dirs still pass; agentDir above sessions is unchanged", () => {
  const same = (tool: string, input: Record<string, unknown>) => {
    for (const role of ["main", "child"] as const) assert.equal(kind(guarded, tool, input, role), kind(plain, tool, input, role), `${role}: ${tool} ${JSON.stringify(input)}`);
  };
  same("write", { path: path.join(art, "run1_output.md"), content: "x" });
  same("bash", { command: `echo x > ${path.join(art, "run1_output.md")}` });
  same("bash", { command: `mv ${path.join(art, "a")} ${path.join(art, "b")}` });
  same("foreman_move", { src: path.join(sessionDir, "x.md"), dst: path.join(sessionDir, "y.md") });
  same("foreman_move", { src: path.join(outer, "other-session"), dst: path.join(outer, "other-session.old") });
});
