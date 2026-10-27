// R31c item 3: /foreman flag-ask. The last ask the owner answered (overlay answer or PS user resolution) becomes one `ask_flag` trace event with the
// complete command (only secret-looking values masked by redactCommand); a flag never allows anything.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { AskFlag } from "../askflag.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { openTrace, sanitizeTrace } from "../trace.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r31c-flag-")));
after(() => rmTestTmp(w));

const written = (rec: Record<string, unknown>): Record<string, unknown> => {
  const t = openTrace({ enabled: true, dir: w, stateDir: w, sessionId: "sess" })!;
  t.emit(rec);
  const lines = fs.readFileSync(t.file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
};

test("A1 an overlay answer is flagged with family, class, rule and the complete command", () => {
  const f = new AskFlag();
  f.overlay({ command: "grep x ~/.pi/agent/pi-foreman/state/trace-a.jsonl | cut -c1-9", rule: "{agentDir}/pi-foreman/state/*", approved: true, session: "sess" });
  const rec = f.flag("sess", "needless")!;
  assert.equal(rec.event, "ask_flag");
  assert.equal(rec.decision, "approved");
  assert.equal(rec.rule, "{agentDir}/pi-foreman/state/*");
  assert.ok(typeof rec.family === "string" && rec.family.length > 0);
  const out = written(rec);
  assert.equal(out.event, "ask_flag");
  assert.equal(out.command, "grep x ~/.pi/agent/pi-foreman/state/trace-a.jsonl | cut -c1-9");
  assert.equal(out.note, "needless");
});

test("A2 a flag of another session is not written; the last answer wins and a denial is flagged as denied", () => {
  const f = new AskFlag();
  f.overlay({ command: "gh run view 123 --log-failed", rule: "gh *", approved: true, session: "sess" });
  assert.equal(f.flag("other"), null);
  f.overlay({ command: "rm x", rule: "rm *", approved: false, session: "sess" });
  const rec = f.flag("sess")!;
  assert.equal(rec.command, "rm x");
  assert.equal(rec.decision, "denied");
  assert.equal(rec.surface, "overlay");
});

test("A4 no answered ask: nothing to flag", () => {
  assert.equal(new AskFlag().flag("sess", "note"), null);
});

test("A5 secrets are masked, paths stay, a long command stays complete; other events keep the cap", () => {
  const cmd = `curl -H "Authorization: Bearer abcdefghijklmnop12345" https://u:pw@example.org/a/b?token=sekrit1234 ${"x".repeat(5)} ${"/some/long/path ".repeat(30)}`;
  const f = new AskFlag();
  f.overlay({ command: cmd, rule: null, approved: false, session: "sess" });
  const out = written(f.flag("sess")!);
  const c = String(out.command);
  assert.ok(c.length > 400, "complete, not cut at 200");
  assert.ok(!c.includes("abcdefghijklmnop12345") && !c.includes("sekrit1234") && !c.includes("u:pw@"));
  assert.ok(c.includes("[redacted]"));
  assert.ok(c.includes("/some/long/path"), "paths are not scrubbed");
  // the exception is for ask_flag only: any other event drops the command, a deny keeps the old cap and scrub
  // R41 item 15: a dialog record keeps its command, redacted and not cut
  const dlg = String(sanitizeTrace({ event: "dialog", command: `curl -H "Authorization: Bearer abcdefghijklmnop12345" ${"y".repeat(600)}` }).command);
  assert.ok(dlg.includes("[redacted]") && !dlg.includes("abcdefghijklmnop12345") && dlg.length > 400);
  assert.ok(String(sanitizeTrace({ event: "overlay", decision: "deny", command: "x".repeat(500) }).command).length <= 200);
  assert.equal(sanitizeTrace({ event: "tool_error", note: "n" }).note, undefined);
});

test("A6 a flag never allows: the flagged shape still asks", () => {
  const baseline = readBaseline(path.resolve(here, "..", "..", ".."))!;
  const rules = buildOverlayRules(baseline, {}, {}, path.join(w, "home", ".pi", "agent"), w, undefined, false);
  const ctx = { cwd: w, home: path.join(w, "home"), platform: process.platform, role: "child" as const };
  const cmd = "git fetch origin";
  const before = checkToolCall(rules, "bash", { command: cmd }, ctx)?.kind;
  const f = new AskFlag();
  f.overlay({ command: cmd, rule: "r", approved: true, session: "sess" });
  assert.ok(f.flag("sess"));
  assert.equal(checkToolCall(rules, "bash", { command: cmd }, ctx)?.kind, before);
  assert.equal(before, "ask");
  // and no source file but the writer, the sanitizer, the command wiring and the retro scripts reads `ask_flag`
  const allowed = new Set(["askflag.ts", "trace.ts", "index.ts"]);
  for (const n of fs.readdirSync(path.resolve(here, ".."))) {
    if (!n.endsWith(".ts") || allowed.has(n)) continue;
    assert.ok(!fs.readFileSync(path.resolve(here, "..", n), "utf8").includes("ask_flag"), n);
  }
});

test("A7 the ask_flag event carries its time (ts) and lands in the session's own trace file", () => {
  const f = new AskFlag();
  f.overlay({ command: "git fetch origin", rule: "r", approved: true, session: "sess" });
  const t = openTrace({ enabled: true, dir: w, stateDir: w, sessionId: "sess", now: () => new Date(Date.UTC(2026, 9, 23, 10, 0, 0)) })!;
  t.emit(f.flag("sess")!);
  assert.equal(path.basename(t.file), "trace-sess.jsonl");
  const out = JSON.parse(fs.readFileSync(t.file, "utf8").trim().split("\n").pop()!) as Record<string, unknown>;
  assert.equal(out.ts, "2026-10-23T10:00:00.000Z");
  assert.equal(out.event, "ask_flag");
  // a flag of another session writes nothing
  assert.equal(f.flag("other"), null);
});
