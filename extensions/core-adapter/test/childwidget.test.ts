import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildRuns, ChildWidget, MAX_ROWS, UsageTail, readOpened, runLine, widgetLines } from "../childwidget.ts";

const line = (launchId: string, input: number, output: number, total: number) => JSON.stringify({ role: "builder", launchId, input, cacheRead: 0, cacheWrite: 0, output, cost: { total } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));

test("row formatting: role, rung, state, tokens, cost", () => {
  const r = { launchId: "l", role: "builder", rung: "model" as const, state: "working" as const, tokensIn: 12345, tokensOut: 900, cost: 0.126, startedAt: 0, endedAt: null };
  assert.equal(runLine(r), "builder · model · working · ↑12.3k ↓900 · $0.13");
  assert.equal(runLine({ ...r, rung: null, state: "done" }), "builder · done · ↑12.3k ↓900 · $0.13");
});

test("usage tail sums per launch id incrementally and waits for a full line", () => {
  const d = tmp();
  const f = path.join(d, "u.jsonl");
  fs.writeFileSync(f, line("a", 100, 10, 0.5) + "\n" + line("a", 50, 5, 0.25) + "\n" + line("b", 1, 1, 1).slice(0, 20));
  const t = new UsageTail(f);
  t.refresh();
  assert.deepEqual(t.by.get("a"), { input: 150, output: 15, cost: 0.75 });
  assert.equal(t.by.has("b"), false);
  fs.appendFileSync(f, line("b", 1, 1, 1).slice(20) + "\n");
  t.refresh();
  assert.equal(t.by.get("b")?.cost, 1);
});

test("state: working -> ask -> working -> done by forwarded prompt, matched on the requester agent name", () => {
  const d = tmp();
  const f = path.join(d, "u.jsonl");
  fs.writeFileSync(f, line("L1", 10, 2, 0.1) + "\n");
  const c = new ChildRuns(new UsageTail(f));
  c.onLaunchCall("call1", { launchId: "L1", role: "builder", rung: "model" });
  c.onLaunched("call1", "run1", [], 1000);
  assert.equal(c.views()[0].state, "working");
  assert.equal(c.views()[0].tokensIn, 10);
  c.onPrompt({ requestId: "r0", forwarding: null, agentName: "builder" }); // the foreman's own prompt: not an ask
  assert.equal(c.views()[0].state, "working");
  c.onPrompt({ requestId: "r1", forwarding: { requesterAgentName: "builder", requesterSessionId: "x" } });
  assert.equal(c.views()[0].state, "ask");
  c.onDecision({ requestId: "r1" });
  assert.equal(c.views()[0].state, "working");
  c.onRunEnd("run1", 2000);
  assert.equal(c.views()[0].state, "done");
});

test("a foreground run that ends before its launch result is done at once", () => {
  const c = new ChildRuns();
  c.onRunEnd("run9", 5);
  c.onLaunched("c", "run9", ["explorer"], 1);
  assert.deepEqual(c.views().map((v) => [v.role, v.state]), [["explorer", "done"]]);
});

test("done rows expire after 10 minutes; rows are capped at 8 with active first", () => {
  const mk = (n: number, state: "working" | "done", endedAt: number | null) => ({ launchId: `l${n}`, role: `r${n}`, rung: null, state, tokensIn: 0, tokensOut: 0, cost: 0, startedAt: n, endedAt });
  const now = 20 * 60 * 1000;
  const lines = widgetLines([mk(1, "done", now - 11 * 60 * 1000), mk(2, "done", now - 1000), mk(3, "working", null)], [], now);
  assert.deepEqual(lines.map((l) => l.split(" · ")[0]), ["r3", "r2"]);
  const many = Array.from({ length: 12 }, (_, i) => mk(i, i < 2 ? "working" : "done", i < 2 ? null : now - 1000));
  const out = widgetLines(many, [{ label: "sess", status: "open", at: now - 90_000 }], now);
  assert.equal(out.length, MAX_ROWS);
  assert.deepEqual(out.slice(0, 3).map((l) => l.split(" · ")[0]), ["r0", "r1", "sess"]);
  assert.equal(out[2], "sess · open · 1m");
});

test("opened sessions are read from sessions.json by parent id", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "pi-foreman", "state"), { recursive: true });
  fs.writeFileSync(path.join(d, "pi-foreman", "state", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { label: "mine", parent: "P", status: "open", opened: "2026-01-01T10:00:00", last: { at: "2026-01-01T10:05:00" } },
    { label: "other", parent: "Q", status: "open", opened: "2026-01-01T10:00:00", last: null },
    { label: "gone", parent: "P", status: "closed", opened: "2026-01-01T10:00:00", last: null },
  ] }));
  const rows = readOpened(d, "P");
  assert.deepEqual(rows.map((r) => [r.label, r.status]), [["mine", "open"]]);
  assert.equal(rows[0].at, Date.parse("2026-01-01T10:05:00"));
  assert.deepEqual(readOpened(d, null), []);
});

test("widget renders only in tui when enabled, throttles, clears when empty", () => {
  const calls: unknown[] = [];
  const ui = { setWidget: (k: string, c: string[] | undefined, o?: unknown) => calls.push([k, c, o]) };
  const d = tmp();
  const w = new ChildWidget(path.join(d, "u.jsonl"));
  const opts = { enabled: true, agentDir: d, intercomId: null };
  w.request({ mode: "rpc", ui }, opts, 10_000);
  w.request({ mode: "tui", ui }, { ...opts, enabled: false }, 10_000);
  assert.equal(calls.length, 0);
  w.runs.onLaunched("c", "run1", ["builder"], 10_000);
  w.request({ mode: "tui", ui }, opts, 10_000);
  assert.deepEqual(calls[0], ["foreman-children", ["builder · working · ↑0 ↓0 · $0.00"], { placement: "belowEditor" }]);
  w.runs.onRunEnd("run1", 10_001);
  w.request({ mode: "tui", ui }, opts, 10_200); // within a second: deferred, not rendered now
  assert.equal(calls.length, 1);
  w.dispose();
  const w2 = new ChildWidget(path.join(d, "u.jsonl"));
  w2.request({ mode: "tui", ui }, opts, 50_000);
  assert.equal(calls.length, 1); // empty and nothing shown before: no call
});
