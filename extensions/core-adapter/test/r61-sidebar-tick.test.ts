import { test } from "node:test";
import assert from "node:assert/strict";
import { SidebarLive, sidebarMayTick, type SidebarDeps, type Tokens } from "../sidebarlive.ts";
import type { LiveStateName } from "../livestate.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = JSON.stringify({ tokens: { fm_hd: "x job", fm_meta: "$1" }, fm_hd_tpl: "{spin} job", stamp: "/s/push/sid.stamp", pane: "w1:p1" });

function rig(state: { name: LiveStateName }) {
  const reports: Tokens[] = [];
  const d: SidebarDeps = {
    pane: "w1:p1",
    sessionId: "sid",
    agentDir: "/a",
    symbols: "unicode",
    push: (_args, done) => setTimeout(() => done(json), 1),
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
    working: () => sidebarMayTick(state.name),
  };
  return { s: new SidebarLive(d), reports };
}

test("the adapter's tick gate: every live state ticks a template except blocked and done", () => {
  const names: LiveStateName[] = ["idle", "working", "waiting", "blocked", "done"];
  assert.deepEqual(names.filter(sidebarMayTick), ["idle", "working", "waiting"]);
});

test("a {spin} template ticks at live state idle and does not at blocked", async () => {
  const state = { name: "idle" as LiveStateName };
  const { s, reports } = rig(state);
  s.request();
  await sleep(80);
  assert.ok(reports.filter((r) => Object.keys(r).join() === "fm_hd").length >= 2, "idle with a template: ticking");
  state.name = "blocked";
  await sleep(30);
  const n = reports.length;
  await sleep(80);
  assert.equal(reports.length, n, "blocked: no tick");
  s.stop();
});
