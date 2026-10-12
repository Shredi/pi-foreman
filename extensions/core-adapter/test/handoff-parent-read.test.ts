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

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hparent-")));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const agent = path.join(home, ".pi", "agent");
const dir = path.join(agent, "pi-foreman", "handoffs", "s1");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(dir, { recursive: true });
for (const f of ["parent", "child", "plan.md", "result.md"]) fs.writeFileSync(path.join(dir, f), "x\n");

const rules = (): OverlayRules => buildOverlayRules(baseline, {}, {}, agent, ws, undefined, false, undefined);
const world = (role: "main" | "child"): MatchCtx => ({ cwd: ws, home, platform: process.platform, role });
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules(), "bash", { command }, world(role))?.kind ?? "pass";
const tool = (role: "main" | "child", name: string, input: Record<string, unknown>): string => checkToolCall(rules(), name, input, world(role))?.kind ?? "pass";

test("own handoff dir: the foreman reads parent and child; writes still ask", () => {
  for (const f of ["parent", "child"]) {
    const p = path.join(dir, f);
    assert.equal(sh("main", `cat ${p}`), "pass", `cat ${f}`);
    assert.equal(tool("main", "read", { path: p }), "pass", `read ${f}`);
    assert.equal(tool("main", "write", { path: p }), "ask", `write ${f}`);
  }
});

test("handoff dirs stay closed to a child (the overlay knows no 'own' dir for a child; plan.md/result.md excepted)", () => {
  assert.equal(sh("child", `cat ${path.join(dir, "plan.md")}`), "pass");
  for (const f of ["parent", "child"]) {
    const p = path.join(dir, f);
    assert.equal(sh("child", `cat ${p}`), "deny", `cat ${f}`);
    assert.equal(tool("child", "write", { path: p }), "deny", `write ${f}`);
  }
});
