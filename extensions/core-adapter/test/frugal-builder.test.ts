import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIEF_MAX, ExplorerBrief } from "../builderbrief.ts";
import { ChildReads, childReadLimits, isReadOnlyBash } from "../childreads.ts";
import { handoffBlock } from "../ladder.ts";

const end = (runId: string, role: string | null, summary: string, status = "completed") => ({ runId, status, role, summary, resultPath: `/r/${runId}` });

test("childReadLimits: coded defaults without config, config wins, absent role = no budget", () => {
  assert.deepEqual(childReadLimits({}, "builder"), { warn: 20, deny: 40 });
  assert.deepEqual(childReadLimits({}, "reviewer"), { warn: 15, deny: 30 });
  assert.equal(childReadLimits({}, "explorer"), null);
  const cfg = { ceremony: { childReads: { builder: { warn: 5, deny: 6 }, explorer: { deny: 9 } } } };
  assert.deepEqual(childReadLimits(cfg, "builder"), { warn: 5, deny: 6 });
  assert.deepEqual(childReadLimits(cfg, "explorer"), { warn: 9, deny: 9 });
  assert.equal(childReadLimits(cfg, "reviewer"), null);
});

test("isReadOnlyBash: reads count, tests, writes and unclear forms do not", () => {
  for (const c of ["cat a.txt", "git log --oneline | head -5", "grep -rn x src && ls", "sed -n 1,5p a", "find . -name '*.ts'"]) assert.equal(isReadOnlyBash(c), true, c);
  for (const c of ["npm test", "echo hi", "cat a > b", "sed -i s/a/b/ f", "find . -delete", "git commit -m x", "ls $(rm x)", "", undefined]) assert.equal(isReadOnlyBash(c), false, String(c));
});

test("ChildReads: warn at warn, deny above deny, nested ids and non-reads are not counted", () => {
  const c = new ChildReads();
  const lim = { warn: 2, deny: 3 };
  assert.equal(c.check("read", "1", {}, lim).kind, "allow");
  assert.equal(c.check("bash", "2", { command: "npm test" }, lim).kind, "allow");
  const w = c.check("grep", "3", {}, lim);
  assert.deepEqual([w.kind, (w as { count: number }).count], ["warn", 2]);
  assert.equal(c.check("grep", "3/1", {}, lim).kind, "allow");
  assert.equal(c.check("find", "4", {}, lim).kind, "warn");
  const d = c.check("read", "5", {}, lim);
  assert.equal(d.kind, "deny");
  assert.match((d as { reason: string }).reason, /STATUS: stuck/);
  assert.equal(c.check("edit", "6", {}, lim).kind, "allow");
  assert.equal(new ChildReads().check("read", "1", {}, null).kind, "allow");
});

test("ExplorerBrief: prepended once to fresh builder steps, bounded, handoff composes in front", () => {
  const b = new ExplorerBrief();
  const input: Record<string, unknown> = { agent: "builder", task: "do it" };
  assert.deepEqual(b.apply(input), []);
  b.onRunEnd(end("e1", "explorer", "x".repeat(BRIEF_MAX + 50)));
  const recs = b.apply(input);
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].event, recs[0].role], ["explorer_brief", "builder"]);
  const task = input.task as string;
  assert.match(task, /^\[pi-foreman explorer brief\]/);
  assert.match(task, new RegExp(`cut at ${BRIEF_MAX} characters`));
  assert.equal(BRIEF_MAX, 8000);
  assert.equal(recs[0].cut, true);
  assert.match(task, /Full result: \/r\/e1/);
  assert.ok(task.endsWith("do it"));
  assert.deepEqual(b.apply({ agent: "builder", task: "again" }), [], "handed over once");
  // ladder handoff goes in front of the brief
  const h = { role: "builder", runId: "b0", cause: "context" as const, summary: "half", resultPath: null };
  assert.ok((handoffBlock(h, []) + task).indexOf("rung-up handoff") < (handoffBlock(h, []) + task).indexOf("explorer brief"));
});

test("ExplorerBrief: other roles, failed runs, resumes and non-builder steps get no brief", () => {
  const b = new ExplorerBrief();
  b.onRunEnd(end("r1", "reviewer", "report"));
  b.onRunEnd(end("e2", "explorer", "report", "failed"));
  assert.deepEqual(b.apply({ agent: "builder", task: "t" }), []);
  b.onRunEnd(end("e3", null, "found it"), ["explorer"]);
  assert.deepEqual(b.apply({ action: "resume", agent: "builder", task: "t" }), []);
  const multi: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "r" }, { agent: "builder", task: "b" }] };
  assert.equal(b.apply(multi).length, 1);
  const t = multi.tasks as { task: string }[];
  assert.equal(t[0].task, "r");
  assert.match(t[1].task, /found it/);
});
