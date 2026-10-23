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

test("A2 a PS prompt answered by the owner is flagged; a flag of another session is not", () => {
  const f = new AskFlag();
  f.prompt({ requestId: "r1", surface: "bash", value: "gh run view 123 --log-failed", request: { surface: "bash", matchedPattern: "gh *" } });
  f.decision({ requestId: "r1", surface: "bash", value: "gh run view 123 --log-failed", result: "allow", resolution: "user_approved_for_session" }, "sess", w);
  const rec = f.flag("sess")!;
  assert.equal(rec.rule, "gh *");
  assert.equal(rec.command, "gh run view 123 --log-failed");
  assert.equal(rec.decision, "approved");
  assert.equal(rec.surface, "bash");
  assert.equal(f.flag("other"), null);
});

test("A3 non-user resolutions are ignored", () => {
  const f = new AskFlag();
  for (const by of ["policy_allow", "policy_deny", "session_approved", "auto_approved", "authorizer_allowed", "authorizer_denied", "confirmation_unavailable", "gate_error", ""]) {
    f.prompt({ requestId: `r-${by}`, surface: "bash", value: "ls" });
    f.decision({ requestId: `r-${by}`, resolution: by, result: "allow" }, "sess", w);
  }
  f.decision({ requestId: "unknown", resolution: "user_approved", result: "allow" }, "sess", w);
  assert.equal(f.flag("sess"), null);
  f.prompt({ requestId: "d1", surface: "bash", value: "rm x" });
  f.decision({ requestId: "d1", resolution: "user_denied", result: "deny" }, "sess", w);
  assert.equal(f.flag("sess")!.decision, "denied");
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
  assert.equal(sanitizeTrace({ event: "dialog", command: "ls" }).command, undefined);
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
