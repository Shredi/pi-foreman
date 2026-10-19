// R16 item 7 follow-up: foreman_dialogs counts the self-ruling refusal (trace guard record `self_ruling`, decision blocked) as self_ruling_refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { dialogReport } from "../dialogs.ts";

const write = (t: { after: (f: () => void) => void }, recs: unknown[]): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r16r-")));
  t.after(() => rmTestTmp(root));
  const file = path.join(root, "trace-r16.jsonl");
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
};

test("r16 dialogs: a blocked self_ruling guard record counts as self_ruling_refusal with its command", (t) => {
  const file = write(t, [
    { event: "guard", guard: "self_ruling", toolFamily: "bash", decision: "blocked", reason: "self_ruling: a session cannot write its own parent's ruling", command: "echo ok > handoff/ruling-1.md", role: "foreman" },
    { event: "guard", guard: "self_ruling", toolFamily: "write", decision: "blocked", reason: "self_ruling: a session cannot write its own parent's ruling", command: "write", role: "builder" },
  ]);
  const rep = dialogReport(file);
  assert.equal(rep.self_ruling_refusal.count, 2);
  assert.deepEqual(rep.self_ruling_refusal.lines, ["echo ok > handoff/ruling-1.md", "write"]);
  assert.equal(rep.other.count, 0);
});

test("r16 dialogs: other guard records and a non-blocked self_ruling record do not count", (t) => {
  const file = write(t, [
    { event: "guard", guard: "destructive", toolFamily: "bash", decision: "blocked", command: "rm x" },
    { event: "guard", guard: "self_ruling", toolFamily: "bash", decision: "allowed", command: "ls" },
  ]);
  const rep = dialogReport(file);
  assert.equal(rep.self_ruling_refusal.count, 0);
  assert.equal(rep.other.count, 0);
});

test("r16 dialogs: a refusal and an overlay ask of the same family are both counted", (t) => {
  const file = write(t, [
    { event: "guard", guard: "self_ruling", toolFamily: "bash", decision: "blocked", command: "a" },
    { event: "overlay", toolFamily: "bash", decision: "ask-approved", class: "self_ruling_refusal", command: "b" },
  ]);
  const rep = dialogReport(file);
  assert.equal(rep.self_ruling_refusal.count, 2);
});
