import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildRuns, ChildWidget, MAX_ROWS, UsageTail, WidgetRows, fitLine, readOpened, runLine, widgetLines } from "../childwidget.ts";
import { HEARTBEAT_MS, LiveState, liveDir } from "../livestate.ts";

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

test("finished runs of the batch fold into one summary line; rows are capped at 8 with active first", () => {
  const mk = (n: number, state: "working" | "done", endedAt: number | null) => ({ launchId: `l${n}`, role: `r${n}`, rung: null, state, tokensIn: 1000, tokensOut: 10, cost: 0.5, startedAt: n, endedAt });
  const now = 20 * 60 * 1000;
  const lines = widgetLines([mk(1, "done", 0), mk(2, "done", now - 1000), mk(3, "working", null), mk(4, "done", now - 500)], [], now);
  assert.deepEqual(lines, ["r3 · working · ↑1.0k ↓10 · $0.50", "2 done · ↑2.0k ↓20 · $1.00"]); // r1 ended before the batch began
  assert.deepEqual(widgetLines([mk(1, "done", now)], [], now), []);
  const many = Array.from({ length: 12 }, (_, i) => mk(i, "working", null));
  const out = widgetLines(many, [{ label: "sess", status: "open", at: now - 90_000 }], now);
  assert.equal(out.length, MAX_ROWS);
  assert.equal(widgetLines([], [{ label: "sess", status: "open", at: now - 90_000 }], now)[0], "sess · open · 1m");
  assert.equal(fitLine("abcdef", 4), "abc…");
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

function stubUi() {
  const st = { sets: 0, renders: 0, notes: 0, rows: null as WidgetRows | null };
  const ui = {
    setWidget: (_k: string, c: ((tui: { requestRender(): void }) => WidgetRows) | undefined) => {
      st.sets++;
      st.rows = c ? c({ requestRender: () => st.renders++ }) : null;
    },
    notify: () => st.notes++,
  };
  return { st, ui, height: () => (st.rows ? st.rows.render(60).length : 0) };
}

test("widget renders only in tui when enabled, throttles, clears when empty", () => {
  const { st, ui } = stubUi();
  const d = tmp();
  const w = new ChildWidget(path.join(d, "u.jsonl"));
  const opts = { enabled: true, agentDir: d, intercomId: null };
  w.request({ mode: "rpc", ui }, opts, 10_000);
  w.request({ mode: "tui", ui }, { ...opts, enabled: false }, 10_000);
  assert.equal(st.sets, 0);
  w.runs.onLaunched("c", "run1", ["builder"], 10_000);
  w.request({ mode: "tui", ui }, opts, 10_000);
  assert.deepEqual(st.rows?.render(80), [" builder · working · ↑0 ↓0 · $0.00"]);
  w.runs.onRunEnd("run1", 10_001);
  w.request({ mode: "tui", ui }, opts, 10_200); // within a second: deferred, not rendered now
  assert.equal(st.sets, 1);
  w.dispose();
  const w2 = new ChildWidget(path.join(d, "u.jsonl"));
  w2.request({ mode: "tui", ui }, opts, 50_000);
  assert.equal(st.sets, 1); // empty and nothing shown before: no call
});

test("height never shrinks while a run is active, updates in place, clears after the last run; notify changes nothing", () => {
  const { st, ui, height } = stubUi();
  const d = tmp();
  const w = new ChildWidget(path.join(d, "u.jsonl"));
  const opts = { enabled: true, agentDir: d, intercomId: null };
  let t = 100_000;
  const step = (f: () => void) => {
    f();
    t += 2000;
    w.request({ mode: "tui", ui }, opts, t);
  };
  const heights: number[] = [];
  step(() => w.runs.onLaunched("a", "r1", ["builder"], t));
  heights.push(height());
  step(() => w.runs.onLaunched("b", "r2", ["reviewer"], t));
  heights.push(height());
  step(() => w.runs.onLaunched("c", "r3", ["explorer"], t));
  heights.push(height());
  step(() => w.runs.onPrompt({ requestId: "q", forwarding: { requesterAgentName: "reviewer" } }));
  heights.push(height());
  step(() => w.runs.onRunEnd("r1", t));
  heights.push(height());
  ui.notify();
  step(() => w.runs.onRunEnd("r3", t));
  heights.push(height());
  step(() => w.runs.onDecision({ requestId: "q" }));
  heights.push(height());
  assert.deepEqual(heights, [1, 2, 3, 3, 3, 3, 3]);
  assert.equal(st.sets, 1); // one component for the whole batch, lines swapped in place
  assert.ok(st.renders >= 5);
  assert.deepEqual(st.rows?.render(60), [" reviewer · working · ↑0 ↓0 · $0.00", " 2 done · ↑0 ↓0 · $0.00", ""]);
  step(() => w.runs.onRunEnd("r2", t));
  assert.equal(height(), 0);
  assert.equal(st.sets, 2); // cleared at the end of the last run
});

test("an unchanged timer tick or a presence heartbeat makes no UI call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  const { st, ui } = stubUi();
  const d = tmp();
  const w = new ChildWidget(path.join(d, "u.jsonl"));
  const opts = { enabled: true, agentDir: d, intercomId: null };
  w.runs.onLaunched("a", "r1", ["builder"], 100_000);
  w.request({ mode: "tui", ui }, opts);
  const live = LiveState.start({ agentDir: d, sessionId: "s1", cwd: d, mode: "tui", env: {} }, () => w.runs.views());
  const before = { ...st };
  w.request({ mode: "tui", ui }, opts); // within the gap: deferred to a timer
  t.mock.timers.tick(1000);
  w.refresh(); // a later tick with the same content
  t.mock.timers.tick(HEARTBEAT_MS * 3);
  const beat = JSON.parse(fs.readFileSync(path.join(liveDir(d), "s1.json"), "utf8")) as { heartbeatAt: string };
  live?.stop();
  w.dispose();
  assert.equal(st.sets, before.sets);
  assert.equal(st.renders, before.renders);
  assert.equal(Date.parse(beat.heartbeatAt), 101_000 + HEARTBEAT_MS * 3); // the heartbeats ran
});
