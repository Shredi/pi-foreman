import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir, presenceState } from "../livestate.ts";
import { symbolSet } from "../symbols.ts";

const base = { done: false, owner: false, turn: false, children: false, externalWaits: false };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r11p-"));
const wait = { id: "w1", kind: "timer", note: "n", ageSeconds: 1, leftSeconds: 60 };
const live = { launchId: "L", role: "builder", rung: "model" as const, model: null, state: "working" as const, tokensIn: 0, tokensOut: 0, cost: 0, startedAt: 0, endedAt: null };

test("presenceState: precedence done > waiting-owner > working > waiting-external > idle", () => {
  assert.equal(presenceState(base), "idle");
  assert.equal(presenceState({ ...base, externalWaits: true }), "waiting-external");
  assert.equal(presenceState({ ...base, externalWaits: true, turn: true }), "working");
  assert.equal(presenceState({ ...base, externalWaits: true, children: true }), "working");
  assert.equal(presenceState({ ...base, externalWaits: true, children: true, turn: true, owner: true }), "waiting-owner");
  assert.equal(presenceState({ owner: true, turn: true, children: true, externalWaits: true, done: true }), "done");
});

test("LiveState presence: each state, with the legacy state field unchanged", () => {
  const d = tmp();
  let runs: (typeof live)[] = [];
  let waits: (typeof wait)[] = [];
  const l = LiveState.start({ agentDir: d, sessionId: "p", cwd: "/w", mode: "rpc", env: {} }, () => runs, undefined, () => waits)!;
  const snap = () => l.snapshot();
  assert.equal(snap().presence, "idle");
  waits = [wait];
  assert.equal(snap().presence, "waiting-external");
  assert.equal(snap().state, "working"); // legacy reader: a pending wait is work
  waits = [];
  runs = [live];
  assert.equal(snap().presence, "working");
  runs = [{ ...live, state: "ask" as never }];
  assert.equal(snap().presence, "idle"); // a child's ask reaches the owner through hold(), not through the run
  runs = [];
  l.onAgentStart();
  assert.equal(snap().presence, "working");
  waits = [wait];
  assert.equal(snap().presence, "working"); // working beats waiting-external
  const release = l.hold();
  assert.equal(snap().presence, "waiting-owner");
  assert.equal(snap().state, "blocked"); // legacy name kept
  release();
  l.onSettled(true);
  waits = [];
  assert.equal(snap().presence, "idle");
  l.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(liveDir(d), "p.json"), "utf8")).presence, "done");
});

test("every presence state has its own icon key, distinct from the other states", () => {
  const s = symbolSet("unicode");
  const icons = [s.working, s["waiting-owner"], s["waiting-external"], s.idle, s.done];
  assert.equal(new Set(icons).size, icons.length);
  const n = symbolSet("nerd");
  const nerd = [n.working, n["waiting-owner"], n["waiting-external"], n.idle, n.done];
  assert.equal(new Set(nerd).size, nerd.length);
});
