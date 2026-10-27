// R46 item 1: `<handoff>/live.json` binds a handoff to a Pi session, so it is write-protected like `parent` and `child`:
// the foreman is asked, a child is denied. (The Pi session file itself is covered by r46-session-file-deny.test.ts.)
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
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-live-")));
const cwd = path.join(root, "proj");
const home = path.join(root, "home");
const agentDir = path.join(home, ".pi", "agent");
const handoff = path.join(agentDir, "pi-foreman", "handoffs", "s1");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(handoff, { recursive: true });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, path.join(root, "pkg"));
const kind = (role: "main" | "child", tool: string, input: Record<string, unknown>): string => checkToolCall(rules, tool, input, { cwd, home, platform: process.platform, role } as MatchCtx)?.kind ?? "pass";
const live = path.join(handoff, "live.json");

test("live.json: a foreman write asks, a child write is denied (write, edit, foreman_move, foreman_copy)", () => {
  for (const [tool, input] of [["write", { path: live, content: "{}" }], ["edit", { path: live }], ["foreman_copy", { src: path.join(cwd, "a"), dst: live }], ["foreman_move", { src: path.join(cwd, "a"), dst: live }]] as [string, Record<string, unknown>][]) {
    assert.equal(kind("main", tool, input), "ask", `main ${tool}`);
    assert.equal(kind("child", tool, input), "deny", `child ${tool}`);
  }
});

test("live.json: a child's shell write is denied; the foreman's shell read stays open", () => {
  assert.equal(kind("child", "bash", { command: `echo '{}' > ${live}` }), "deny");
  assert.equal(kind("child", "bash", { command: `tee ${live}` }), "deny");
  assert.equal(kind("main", "bash", { command: `cat ${live}` }), "pass");
});

test("the baseline lists live.json next to parent and child in both blocks", () => {
  const text = fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8");
  for (const f of ["parent", "child", "live.json"]) assert.equal(text.split(`handoffs/*/${f}"`).length - 1, 2, f);
});
