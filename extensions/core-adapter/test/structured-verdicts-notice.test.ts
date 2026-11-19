// The completion-notice path of the review verdict record (plan structured-verdicts T7, §2/§4): a run that did not complete gives no record there either
// (the run end caches null and the persisted route says `failed`, so a reload knows), the round verdict is built from the review runs of the notice that
// have a record only, and a notice names only runs this session launched.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { tick, world as reloadWorld } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

type T = Parameters<typeof r11Rig>[0];
const ledgerText = `# SV\n\n- [ ] 1. item 1\n- [ ] 2. item 2\n- [ ] V. verify\n`;
const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));
const done = (text: string, n: number | string): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(text);
const dirLine = (runId: string): string => `Retention-managed async directory: /tmp/x/${runId}`;
const grouped = (...ids: [string, string][]): string => `Background tasks completed (${ids.length}): ${ids.map(([, role]) => `**${role}**`).join(", ")}\n\nreports\n\n${ids.map(([id]) => dirLine(id)).join("\n")}\n`;

async function world(t: T) {
  const entries: unknown[] = [];
  const base = reviewAllowOpts();
  const sessionManager = { getSessionId: () => process.env.PI_INTERCOM_SESSION_ID ?? "", getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries };
  const a = await r11Rig(t, { default: "standard" }, {
    ...base,
    ctx: { ...base.ctx, sessionManager },
    piExtra: { appendEntry: (customType: string, data: unknown) => void (customType === "pi-foreman-ledger-route" && entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) })) },
  });
  const ledger = path.join(a.project, ".workflow", "LEDGER-sv.md");
  await a.toolDoing("write", { path: ledger }, () => fs.writeFileSync(ledger, ledgerText));
  let n = 0;
  const start = async (agent: string, extra: Record<string, unknown>, task: string) => {
    const input: Record<string, unknown> = { agent, task, ...extra };
    const l = await a.launch(input);
    assert.equal(l.res, undefined, l.res?.reason);
    const runId = `sv-run-${++n}`;
    await a.started(l.id, input, runId);
    return { input, runId, dir: bindingOf(input)?.verdictDir ?? "" };
  };
  return {
    a,
    text: () => fs.readFileSync(ledger, "utf8"),
    review: (extra: Record<string, unknown> = {}, task = "review item 1") => start("reviewer", extra, task),
    builder: (task = "build it") => start("builder", {}, task),
    end: (runId: string, agent = "reviewer", status = "completed") => a.end({ runId, agent, status, success: status === "completed", results: [{ agent, status, success: status === "completed", output: "see the record" }] }),
  };
}

test("a timed-out reviewer with a pass record: the grouped notice marks nothing (items and V)", { skip }, async (t) => {
  const w = await world(t);
  const cut = await w.review({ items: [1, "V"] });
  const other = await w.review({}, "review item 2");
  assert.ok(w.a.record(cut.runId, { verdict: "pass", items: [{ id: 1, result: "pass" }, { id: "V", result: "pass" }] }));
  w.end(cut.runId, "reviewer", "timed-out");
  await settle();
  assert.equal(w.a.events("review_record_ignored").length, 1);
  await w.a.notice(grouped([cut.runId, "reviewer"], [other.runId, "reviewer"]));
  await settle(300);
  assert.ok(!done(w.text(), 1) && !done(w.text(), "V"), w.text());
  assert.equal(w.a.events("ledger_mark_by_review").length, 0);
});

test("a passing reviewer plus an explorer in one grouped notice: the round stays PASS; a notice with no directory line changes nothing", { skip }, async (t) => {
  const w = await world(t);
  const b = await w.builder();
  w.end(b.runId, "builder");
  const r = await w.review();
  assert.ok(w.a.record(r.runId, { verdict: "pass", items: [{ id: 1, result: "pass" }] }));
  w.end(r.runId);
  await settle();
  const explorer = "sv-explorer";
  await w.a.notice(grouped([r.runId, "reviewer"], [explorer, "explorer"]));
  await w.a.notice("Background task completed: **reviewer**\n\nno directory line here\n");
  await settle(300);
  assert.equal(w.a.events("ledger_mark_by_review").length, 1, "marked once");
  const next = await w.builder("more");
  assert.ok(next.runId);
  assert.equal(w.a.events("revision").length, 0, "no revision after a PASS");
});

test("a notice naming an id this session never launched reads no record", { skip }, async (t) => {
  const w = await world(t);
  const r = await w.review();
  const foreign = path.join(r.dir, "..", "foreign-launch");
  fs.mkdirSync(foreign, { recursive: true });
  const live = path.join(foreign, "verdict.json");
  fs.writeFileSync(live, JSON.stringify({ v: 1, launchId: "foreign-launch", at: new Date().toISOString(), verdict: "pass", items: [{ id: 1, result: "pass" }], findings: [] }));
  await w.a.notice(grouped(["never-launched", "reviewer"]));
  await settle(300);
  assert.equal(fs.existsSync(live), true, "the foreign record was not read");
  assert.equal(w.a.events("ledger_mark_by_review").length, 0);
  assert.equal(w.a.events("review_record_invalid").length, 0);
});

test("a notice before the run end reads nothing; the run end then decides", { skip }, async (t) => {
  const w = await world(t);
  const r = await w.review();
  assert.ok(w.a.record(r.runId, { verdict: "pass", items: [{ id: 1, result: "pass" }] }));
  await w.a.notice(grouped([r.runId, "reviewer"]));
  await settle(300);
  assert.equal(fs.existsSync(path.join(r.dir, "verdict.json")), true, "the live file is left for the run end");
  assert.ok(!done(w.text(), 1));
  w.end(r.runId, "reviewer", "failed");
  await settle();
  assert.ok(!done(w.text(), 1), "the run that did not complete marks nothing");
});

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n- [ ] V. verify\n";
const failedEnd = (runId: string) => ({ runId, agent: "reviewer", success: false, status: "failed", results: [{ agent: "reviewer", status: "failed", success: false, output: "died" }] });
const noticeOf = (runId: string): string => `Background tasks completed (2): **reviewer**, **reviewer**\n\nx\n\n${dirLine(runId)}\n`;

test("after a reload the notice of a failed run marks nothing (the route says failed), the one of a completed run still marks", async (t) => {
  const w = reloadWorld(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const bad = await a.reviewLaunch("review item 1", { items: [1] });
  const good = await a.reviewLaunch("review item 2", { items: [2] });
  assert.equal(bad.blocked, null, String(bad.blocked));
  assert.equal(good.blocked, null, String(good.blocked));
  assert.ok(a.record(bad.id, { verdict: "pass", items: [{ id: 1, result: "pass" }] }));
  await a.endEvent(failedEnd(`run-${bad.id}`));
  await tick(300);
  const routes = w.entries.filter((e) => e.customType === "pi-foreman-ledger-route").map((e) => e.data as { run: string; review?: { failed?: boolean } });
  assert.ok(routes.some((r) => r.run === `run-${bad.id}` && r.review?.failed === true), "the failed route is persisted");
  assert.ok(a.record(good.id, { verdict: "pass", items: [{ id: 2, result: "pass" }] }));
  await a.endEvent({ runId: `run-${good.id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "ok" }] });
  await tick(300);
  const b = await w.adapter("reload");
  const fire = (runId: string) => b.fire("message_end", { message: { role: "custom", customType: "subagent-notify", content: noticeOf(runId) } });
  await fire(`run-${bad.id}`);
  await tick(400);
  const ledger = (): string => fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
  assert.ok(!/- \[x\] 1\. /.test(ledger()), ledger());
  await fire(`run-${good.id}`);
  await tick(400);
  assert.ok(/- \[x\] 2\. /.test(ledger()), ledger());
});
