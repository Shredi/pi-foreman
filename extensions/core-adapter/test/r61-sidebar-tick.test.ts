import { test } from "node:test";
import assert from "node:assert/strict";
import { SidebarLive, type SidebarDeps, type Tokens } from "../sidebarlive.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTpl = JSON.stringify({ tokens: { fm_hd: "x job", fm_meta: "$1" }, fm_hd_tpl: "{spin} job", stamp: "/s/push/sid.stamp", pane: "w1:p1" });
const noTpl = JSON.stringify({ tokens: { fm_hd: "x job", fm_meta: "$1" }, fm_hd_tpl: null, stamp: "/s/push/sid.stamp", pane: "w1:p1" });

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

test("a {spin} template ticks, and the ticking stops once the push carries none (the push is the one source)", async () => {
  const out = { json: withTpl };
  const { s, reports } = rig(out);
  s.request();
  await sleep(80);
  assert.ok(reports.filter((r) => Object.keys(r).join() === "fm_hd").length >= 2, "template: ticking");
  out.json = noTpl; // e.g. the session now waits for the owner
  s.request();
  await sleep(30);
  const n = reports.length;
  await sleep(80);
  assert.equal(reports.length, n, "no template: no tick");
  s.stop();
});
