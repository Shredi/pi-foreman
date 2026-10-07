import test from "node:test";
import assert from "node:assert/strict";
import { syncCommand } from "../close.ts";
import { endActive, trackActive } from "../actions.ts";

test("active runs: a launch or resume adds the run id, a run-end event removes it", () => {
  const a = new Set<string>();
  trackActive(a, { agent: "builder", task: "x" }, { runId: "r1" }, false);
  trackActive(a, { action: "resume", id: "r1" }, { asyncId: "r2" }, false);
  assert.deepEqual([...a], ["r1", "r2"]);
  endActive(a, { runId: "r1" });
  endActive(a, { nothing: 1 });
  assert.deepEqual([...a], ["r2"]);
});

test("active runs: status calls, errors and results without an id add nothing", () => {
  const a = new Set<string>();
  trackActive(a, { action: "status" }, { runId: "r1" }, false);
  trackActive(a, { agent: "builder" }, { runId: "r1" }, true);
  trackActive(a, { agent: "builder" }, {}, false);
  assert.equal(a.size, 0);
});

test("sync: refused while child runs are active, runs the script otherwise", async () => {
  const notes: string[] = [];
  let ran = 0;
  const d = (n: number) => ({ activeRuns: n, run: async () => (ran++, { text: "synced", ok: true }), notify: (t: string, l: string) => void notes.push(`${l}:${t}`) });
  await syncCommand(d(2));
  assert.deepEqual(notes, ["warning:sync refused: 2 child run(s) still active"]);
  assert.equal(ran, 0);
  await syncCommand(d(0));
  assert.equal(ran, 1);
  assert.equal(notes.at(-1), "info:synced");
});
