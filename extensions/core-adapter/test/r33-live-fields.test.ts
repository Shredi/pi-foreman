import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOwnAddonTasks, readAddonTasks } from "../bg.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { writeStampAtomic } from "../sidebarlive.ts";
import { spinnerFrame, symbolSet } from "../symbols.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r33l-"));
const run = { launchId: "l", role: "b", rung: null, model: null, state: "working" as const, tokensIn: 0, tokensOut: 0, cost: 0, startedAt: 0, endedAt: null };

test("four glyph sets (unknown -> unicode) with the new keys and the spinner frames", () => {
  assert.equal(symbolSet("bogus").agent, "◆");
  assert.equal(symbolSet("emoji").done, "✅");
  assert.equal(symbolSet("emoji").agent, "🤖");
  assert.equal(symbolSet("ascii").working, "*");
  assert.deepEqual(symbolSet("ascii").spinner, ["|", "/", "-", "\\"]);
  assert.equal(symbolSet("ascii").keepalive, "^");
  assert.equal(symbolSet("emoji").keepalive, "♨️");
  assert.equal(symbolSet("nerd").task, "\uf013");
  assert.equal(symbolSet("unicode").spinner.length, 8);
  const frames = ["a", "b", "c"];
  assert.equal(spinnerFrame(frames, 0), "a");
  assert.equal(spinnerFrame(frames, 249), "a");
  assert.equal(spinnerFrame(frames, 250), "b");
  assert.equal(spinnerFrame(frames, 750), "a");
});

function task(cwd: string, dir: string, id: string, extra: Record<string, unknown> = {}) {
  const base = path.join(cwd, ".pi", "tasks", dir);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, `${id}.json`), JSON.stringify({ id, status: "running", startTime: 10_000, name: `job ${id}`, pid: 7, ...extra }));
}

test("readOwnAddonTasks lists only <sessionId>-<digits> dirs, with no log tails; readAddonTasks still lists all", () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".pi", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "tasks", "out.log"), "line\n");
  task(cwd, "sess-4321", "mine", { outputPath: ".pi/tasks/out.log" });
  task(cwd, "sess-1-4321", "other1"); // the session "sess-1", not "sess"
  task(cwd, "sess2-9", "other2");
  task(cwd, "xsess-9", "other3");
  task(cwd, "sess-4321", "done", { status: "exited" });
  const own = readOwnAddonTasks(cwd, "sess", 15_000);
  assert.deepEqual(own, [{ id: "mine", label: "job mine", pid: 7, ageSeconds: 5, tail: [] }]);
  assert.deepEqual(readOwnAddonTasks(cwd, "sess-1", 15_000).map((x) => x.id), ["other1"]);
  assert.deepEqual(readOwnAddonTasks(cwd, "none"), []);
  assert.deepEqual(readOwnAddonTasks(path.join(cwd, "missing"), "sess"), []);
  assert.equal(readAddonTasks(cwd, 15_000).length, 4);
  const dotted = tmp();
  task(dotted, "a.b-1", "x");
  task(dotted, "aXb-1", "y");
  assert.deepEqual(readOwnAddonTasks(dotted, "a.b").map((x) => x.id), ["x"], "the id is matched literally");
});

test("live file: waits keep bg, the pr_watch entry carries prs, tasks come from this session's dir, asks while an own ask is open", () => {
  const agent = tmp();
  const cwd = tmp();
  task(cwd, "s1-100", "t1");
  task(cwd, "s9-100", "t2");
  const hand = path.join(agent, "pi-foreman", "handoffs", "20260101-120000-job");
  fs.mkdirSync(hand, { recursive: true });
  fs.writeFileSync(path.join(hand, "child"), "s1\n");
  const waits = [
    { id: "w1", kind: "pid", note: "make", ageSeconds: 3.4, leftSeconds: 10, bg: true },
    { id: "w2", kind: "timer", note: "", ageSeconds: 1, leftSeconds: 9 },
    { id: "pr_watch", kind: "pr", note: "2 pr watch", ageSeconds: 0, leftSeconds: 0, prs: [12, 14] },
  ];
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd, mode: "rpc", env: {} }, () => [], undefined, () => waits);
  assert.ok(l);
  const read = () => JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8"));
  l.flush();
  const a = read();
  assert.equal(a.waits[0].bg, true);
  assert.equal("bg" in a.waits[1], false);
  assert.deepEqual(a.waits[2].prs, [12, 14]);
  assert.deepEqual(a.tasks.map((x: { id: string; tail: string[] }) => [x.id, x.tail]), [["t1", []]]);
  assert.equal("asks" in a, false, "no ask, no field");
  fs.writeFileSync(path.join(hand, "ask.md"), "# Ask 1: rule scope\n\nbody\n");
  fs.writeFileSync(path.join(hand, ".ask"), "ask-1\n");
  l.flush();
  assert.deepEqual(read().asks, [{ n: 1, topic: "rule scope" }]);
  fs.writeFileSync(path.join(hand, ".seen"), "ruling-1.md");
  l.flush();
  assert.equal("asks" in read(), false, "answered: gone");
  l.stop();
});

test("stamp: written atomically with the pane id, creating the folder; no temp file is left", () => {
  const d = tmp();
  const file = path.join(d, "state", "push", "sid.stamp");
  writeStampAtomic(file, "w1:p1");
  assert.equal(fs.readFileSync(file, "utf8"), "w1:p1");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["sid.stamp"]);
});
