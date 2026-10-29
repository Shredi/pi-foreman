// R12 item 7: `/foreman dialogs --json` counts the trace's overlay ask dialogs per regression family; the commands are redacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { dialogFields, dialogsJson } from "../dialogs.ts";
import { openTrace } from "../trace.ts";

function open(t: { after(fn: () => void): void }, enabled: unknown = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r12d-")));
  t.after(() => rmTestTmp(dir));
  return openTrace({ enabled, dir: undefined, stateDir: dir, sessionId: "s1" });
}
const ask = (command: string, decision = "ask-approved") => ({ event: "overlay", toolFamily: "bash", decision, command, ...dialogFields(command) });

test("dialogs_trace_three_state_usage_prints_three", (t) => {
  const tr = open(t)!;
  for (const c of ["cat ~/.pi/agent/pi-foreman/state/session-1.json", "cat ~/.pi/agent/pi-foreman/usage/usage-2026.jsonl", "tail -n 5 ~/.pi/agent/pi-foreman/state/usage-s1.jsonl"]) tr.emit(ask(c));
  tr.emit(ask("node --version"));
  const rep = JSON.parse(dialogsJson(tr));
  assert.equal(rep.state_usage_read.count, 3);
  assert.equal(rep.state_usage_read.lines.length, 3);
  assert.equal(rep.toolchain_probe.count, 1);
  assert.equal(rep.other.count, 0);
  assert.ok(rep.state_usage_read.lines.every((l: string) => typeof l === "string" && l.length > 0 && l.length <= 200));
});

test("dialogs_trace_redacts_secrets", (t) => {
  const tr = open(t)!;
  tr.emit(ask("curl -H 'Authorization: Bearer abcdef0123456789abcdef0123456789' https://x.example/a && GITHUB_TOKEN=ghp_abcdefghijklmnop123456 run"));
  tr.emit(ask(`echo ${"a1".repeat(150)}`, "ask-denied"));
  const raw = fs.readFileSync(tr.file, "utf8");
  assert.ok(!raw.includes("abcdef0123456789abcdef0123456789") && !raw.includes("ghp_abcdefghijklmnop123456"));
  const rep = JSON.parse(dialogsJson(tr));
  assert.equal(rep.other.count, 2);
  for (const l of rep.other.lines as string[]) assert.ok(!l.includes("ghp_") && !l.includes("abcdef0123456789abcdef0123456789"), l); // R41 item 15: no length cap, redaction only
});

test("dialogs_trace_off_says_so_never_zero_counts", (t) => {
  const tr = open(t, false);
  assert.equal(tr, null);
  const rep = JSON.parse(dialogsJson(tr));
  assert.equal(rep.trace, "off");
  assert.equal(rep.state_usage_read, undefined);
});
