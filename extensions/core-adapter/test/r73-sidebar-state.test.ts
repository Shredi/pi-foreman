import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, presenceState, type PresenceName } from "../livestate.ts";
import { SidebarLive, type SidebarDeps, type Tokens } from "../sidebarlive.ts";
import { symbolSet } from "../symbols.ts";
import { countChildren } from "../herdrmeta.ts";
import type { Registry } from "../session.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r73-"));
const base = { done: false, owner: false, turn: false, children: false, externalWaits: false };
const run = { launchId: "L", role: "builder", rung: "model" as const, model: null, state: "working" as const, tokensIn: 0, tokensOut: 0, cost: 0, startedAt: 0, endedAt: null };
const wait = { id: "w1", kind: "timer", note: "n", ageSeconds: 1, leftSeconds: 60 };

const withTpl = JSON.stringify({ tokens: { fm_hd: "static job", fm_meta: "$1" }, fm_hd_tpl: "{spin} job", stamp: "/s/push/sid.stamp", pane: "w1:p1" });
const noTpl = JSON.stringify({ tokens: { fm_hd: "static job", fm_meta: "$1" }, fm_hd_tpl: null, stamp: "/s/push/sid.stamp", pane: "w1:p1" });

function rig(out: { json: string }) {
  const reports: Tokens[] = [];
  const d: SidebarDeps = {
    pane: "w1:p1",
    sessionId: "sid",
    agentDir: "/a",
    symbols: "unicode",
    push: (_args, done) => setTimeout(() => done(out.json), 1),
    report: async (tokens) => {
      reports.push(tokens);
    },
    writeStamp: () => {},
    flush: () => {},
    finish: () => {},
    gapMs: 0,
    refreshMs: 100_000,
    tickMs: 10,
    frames: ["a", "b"],
  };
  return { s: new SidebarLive(d), reports };
}

test("the ticker follows the push: it ticks while the template is pushed and stops when the push carries none", async () => {
  const out = { json: withTpl };
  const { s, reports } = rig(out);
  s.request();
  await sleep(80);
  assert.ok(reports.filter((r) => Object.keys(r).join() === "fm_hd").length >= 2, "template pushed: ticking");
  out.json = noTpl;
  s.request();
  await sleep(40);
  const n = reports.length;
  await sleep(80);
  assert.equal(reports.length, n, "no template: no tick");
  s.stop();
});

test("no frozen spinner frame: when the ticking stops the static fm_hd is sent again", async () => {
  const out = { json: withTpl };
  const { s, reports } = rig(out);
  s.request();
  await sleep(60);
  assert.ok(reports.some((r) => /^[ab] job$/.test(String(r.fm_hd))), "a frame was shown");
  out.json = noTpl;
  s.request();
  await sleep(60);
  const last = reports[reports.length - 1];
  assert.equal(last.fm_hd, "static job", "the last report carries the static header, not a frame");
  s.stop();
});

test("presenceState: needs-you (an own blocker or an open ask) beats the spinner states, done beats it", () => {
  const p = (i: Partial<typeof base> & { asks?: boolean }): PresenceName => presenceState({ ...base, ...i });
  assert.equal(p({ owner: true }), "needs-you");
  assert.equal(p({ asks: true }), "needs-you");
  assert.equal(p({ asks: true, turn: true, children: true, externalWaits: true }), "needs-you");
  assert.equal(p({ turn: true, children: true }), "working");
  assert.equal(p({ asks: true, owner: true, done: true }), "done");
});

test("LiveState: a child's permission ask forwarded to the parent after its turn ended shows needs-you until answered or timed out", () => {
  const d = tmp();
  let runs: (typeof run)[] = [];
  const l = LiveState.start({ agentDir: d, sessionId: "p", cwd: "/w", mode: "rpc", env: {} }, () => runs)!;
  l.onAgentStart();
  l.onSettled(true); // the parent's turn has ended
  runs = [{ ...run, state: "ask" as never }];
  assert.equal(l.snapshot().presence, "needs-you");
  runs = [run]; // answered: the child works again
  assert.equal(l.snapshot().presence, "working");
  runs = [{ ...run, state: "ask" as never }];
  assert.equal(l.snapshot().presence, "needs-you");
  runs = [{ ...run, state: "done" as never, endedAt: 5 }]; // timed out: the run ended
  assert.equal(l.snapshot().presence, "idle");
  l.stop();
});

test("LiveState: an own dialog shows needs-you and clears on release", () => {
  const d = tmp();
  const l = LiveState.start({ agentDir: d, sessionId: "p", cwd: "/w", mode: "rpc", env: {} }, () => [], undefined, () => [wait])!;
  assert.equal(l.snapshot().presence, "waiting-external");
  const release = l.hold();
  assert.equal(l.snapshot().presence, "needs-you");
  release();
  assert.equal(l.snapshot().presence, "waiting-external");
  l.stop();
});

test("LiveState: an open ask.md with no ruling shows needs-you and clears when ruling-<n>.md is seen", () => {
  const d = tmp();
  const dir = path.join(d, "pi-foreman", "handoffs", "20260101-000000-job");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "child"), "kid-1\n");
  fs.writeFileSync(path.join(dir, "ask.md"), "# Ask 1: which way\n");
  fs.writeFileSync(path.join(dir, ".ask"), "ask-1\n");
  const l = LiveState.start({ agentDir: d, sessionId: "kid-1", cwd: "/w", mode: "rpc", env: { PI_INTERCOM_SESSION_ID: "kid-1" } }, () => [])!;
  assert.equal(l.snapshot().presence, "needs-you");
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "go\n");
  fs.writeFileSync(path.join(dir, ".seen"), "ruling-1.md\n");
  assert.equal(l.snapshot().presence, "idle");
  l.stop();
});

test("the needs-you icon is its own glyph in every set, distinct from the other states", () => {
  for (const name of ["unicode", "nerd", "emoji", "ascii"]) {
    const s = symbolSet(name);
    const icons = [s.working, s["waiting-external"], s.idle, s.done, s["needs-you"]];
    assert.ok(s["needs-you"], name);
    assert.equal(new Set(icons).size, icons.length, name);
  }
  assert.equal(symbolSet("unicode")["needs-you"], "❓");
  assert.equal(symbolSet("ascii")["needs-you"], "?");
});

test("countChildren counts children recorded under the parent's Pi session id too (restart), like the tree rows", () => {
  const reg = { version: 1, sessions: [1, 2, 3, 4].map((i) => ({ label: `k${i}`, child: `c${i}`, parent: i % 2 ? "old-id" : "pi-sess", status: "open", handoff: `/h/${i}` })) } as unknown as Registry;
  assert.equal(countChildren(reg, "new-id", "pi-sess"), 2);
  assert.equal(countChildren(reg, "old-id", "pi-sess"), 4);
});
