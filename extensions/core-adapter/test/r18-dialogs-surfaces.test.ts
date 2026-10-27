// R18 item 2: `foreman_dialogs` / `/foreman dialogs --json` count every blocking surface, one family each, with a `total`
// of the blocking families only (not auto_review_allow, not the self-ruling refusal).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dialogsJson, dialogReport } from "../dialogs.ts";
import { openTrace } from "../trace.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "r18-dialogs-mixed.jsonl");

test("mixed_fixture_one_per_surface_total_seven", () => {
  const rep = JSON.parse(dialogsJson({ file: FIXTURE })) as Record<string, { count: number; lines: string[] } | number>;
  const counts = Object.fromEntries(Object.entries(rep).filter(([k]) => k !== "total").map(([k, v]) => [k, (v as { count: number }).count]).filter(([, n]) => n !== 0));
  assert.deepEqual(counts, { toolchain_probe: 1, self_ruling_refusal: 1, auto_review_allow: 1, permission_prompt: 1, child_dialogs: 1, checkpoint: 1, ask_user_question: 1, guard_ask: 1, drift_ask: 1 });
  assert.equal(rep.total, 7, "seven blocking surfaces; the auto allow and the refusal are not dialogs");
  assert.deepEqual((rep.child_dialogs as { lines: string[] }).lines, ["builder"]);
  assert.deepEqual((rep.guard_ask as { lines: string[] }).lines, ["git:bash"], "no-ui and child outcomes opened no dialog");
});

test("report_type_has_no_total_and_trace_off_has_none", () => {
  assert.equal("total" in dialogReport(FIXTURE), false);
  assert.equal(JSON.parse(dialogsJson(null)).total, undefined);
  assert.equal(JSON.parse(dialogsJson({ file: path.join(os.tmpdir(), "pf-r18-missing.jsonl") })).total, 0);
});

test("dialog_surface_survives_the_trace_writer", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r18d-")));
  t.after(() => rmTestTmp(dir));
  const tr = openTrace({ enabled: true, dir: undefined, stateDir: dir, sessionId: "s1" })!;
  tr.emit({ event: "dialog", surface: "checkpoint" });
  tr.emit({ event: "dialog", surface: "nonsense" });
  const rep = dialogReport(tr.file);
  assert.equal(rep.checkpoint.count, 1);
  assert.equal(JSON.parse(dialogsJson(tr)).total, 1, "an unknown surface counts nowhere");
});

test("package_permission_events_count_nowhere", async (t) => {
  const a = await r11Rig(t);
  a.channel("permissions:ui_prompt", { requestId: "r1", forwarding: { requesterAgentName: "builder" } });
  a.channel("permissions:ui_prompt", { requestId: "r2" });
  assert.deepEqual(a.events("dialog"), []);
});
