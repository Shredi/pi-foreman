import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SidebarLive, REPUSH_MS, reportMetadata, socketPath, type SidebarDeps, type Tokens } from "../sidebarlive.ts";
import { symbolSet, spinnerFrame } from "../symbols.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r33-"));

test("socket report framing: one JSON line with method, pane, source, tokens and the 15 s ttl; an error reply rejects", async () => {
  const d = tmp();
  const endpoint = (name: string) => (process.platform === "win32" ? `\\\\.\\pipe\\r33-${process.pid}-${Date.now()}-${name}` : path.join(d, `${name}.sock`));
  const sock = endpoint("h");
  const seen: string[] = [];
  let reply = (id: string) => JSON.stringify({ id, result: {} });
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (b) => {
      buf += b.toString("utf8");
      if (!buf.includes("\n")) return;
      seen.push(buf);
      c.write(reply(JSON.parse(buf).id) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, resolve);
  });
  try {
    const tokens: Tokens = { fm_hd: "⠋⠀ job", fm_a1: null };
    await reportMetadata(sock, { pane_id: "w1:p1", source: "plugin:pi-foreman.sidebar", tokens, ttl_ms: 15000 });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].endsWith("\n") && seen[0].indexOf("\n") === seen[0].length - 1, "exactly one line");
    const req = JSON.parse(seen[0]);
    assert.equal(typeof req.id, "string");
    assert.equal(req.method, "pane.report_metadata");
    assert.deepEqual(req.params, { pane_id: "w1:p1", source: "plugin:pi-foreman.sidebar", tokens, ttl_ms: 15000 });
    reply = (id) => JSON.stringify({ id, error: { message: "no" } });
    await assert.rejects(reportMetadata(sock, { pane_id: "p", source: "s", tokens: {}, ttl_ms: 1 }));
  } finally {
    server.close();
  }
  await assert.rejects(reportMetadata(endpoint("none"), { pane_id: "p", source: "s", tokens: {}, ttl_ms: 1 }), "no server: rejects");
});

test("socket path: HERDR_SOCKET_PATH, else <XDG_CONFIG_HOME>/herdr/herdr.sock, else ~/.config/herdr/herdr.sock", () => {
  assert.equal(socketPath({ HERDR_SOCKET_PATH: "/x/s.sock", XDG_CONFIG_HOME: "/c" }), "/x/s.sock");
  assert.equal(socketPath({ XDG_CONFIG_HOME: "/c" }), path.join("/c", "herdr", "herdr.sock"));
  assert.equal(socketPath({}), path.join(os.homedir(), ".config", "herdr", "herdr.sock"));
});

const out = (over: Record<string, unknown> = {}) => JSON.stringify({ tokens: { fm_hd: "⏳⠀ job", fm_meta: "$1" }, fm_hd_tpl: null, stamp: "/s/push/sid.stamp", pane: "w1:p1", ...over });

function rig(over: Partial<SidebarDeps> = {}, stdout: () => string = () => out()) {
  const calls: string[] = [];
  const pushes: string[][] = [];
  const reports: Tokens[] = [];
  const stamps: [string, string][] = [];
  const st = { fail: false, now: 1_000_000 };
  const d: SidebarDeps = {
    pane: "w1:p1",
    sessionId: "sid",
    agentDir: "/a",
    symbols: "ascii",
    push: (args, done) => {
      pushes.push(args);
      calls.push(args.includes("--json") ? "push-json" : "push");
      setTimeout(() => done(args.includes("--json") ? stdout() : ""), 1);
    },
    report: async (tokens) => {
      calls.push("report");
      if (st.fail) throw new Error("down");
      reports.push(tokens);
    },
    writeStamp: (f, p) => {
      calls.push("stamp");
      stamps.push([f, p]);
    },
    flush: () => {},
    finish: () => {},
    gapMs: 0,
    refreshMs: 100_000,
    nowMs: () => st.now,
    ...over,
  };
  return { s: new SidebarLive(d), calls, pushes, reports, stamps, st };
}

test("json mode: push --json, then the socket report, then the stamp with the pane id; all four symbol values are passed", async () => {
  for (const sym of ["unicode", "nerd", "emoji", "ascii"]) {
    const { s, pushes } = rig({ symbols: sym });
    s.request();
    assert.deepEqual(pushes[0], ["push", "--session", "sid", "--pane", "w1:p1", "--agent-dir", "/a", "--symbols", sym, "--json"]);
    s.stop();
  }
  const { s, calls, reports, stamps } = rig();
  s.request();
  await sleep(30);
  assert.deepEqual(calls.slice(0, 3), ["push-json", "report", "stamp"]);
  assert.deepEqual(reports[0], { fm_hd: "⏳⠀ job", fm_meta: "$1" });
  assert.deepEqual(stamps[0], ["/s/push/sid.stamp", "w1:p1"]);
  s.stop();
});

test("a failed report writes no stamp and falls back to a plain push for that cycle", async () => {
  const { s, calls, pushes, stamps, st } = rig();
  st.fail = true;
  s.request();
  await sleep(40);
  assert.deepEqual(calls.slice(0, 3), ["push-json", "report", "push"]);
  assert.deepEqual(stamps, []);
  assert.ok(!pushes[1].includes("--json"));
  s.stop();
});

test("unusable --json output falls back to a plain push; {} (another session owns the pane) does nothing", async () => {
  const bad = rig({}, () => "");
  bad.s.request();
  await sleep(30);
  assert.deepEqual(bad.calls, ["push-json", "push"]);
  bad.s.stop();
  const loser = rig({}, () => "{}");
  loser.s.request();
  await sleep(30);
  assert.deepEqual(loser.calls, ["push-json"]);
  loser.s.stop();
});

test("unchanged tokens are not re-sent before 10 s (the stamp is still written), and are re-sent after", async () => {
  const { s, reports, stamps, st } = rig();
  s.request();
  await sleep(30);
  st.now += REPUSH_MS - 1;
  s.request();
  await sleep(30);
  assert.equal(reports.length, 1);
  assert.equal(stamps.length, 2);
  st.now += 2;
  s.request();
  await sleep(30);
  assert.equal(reports.length, 2);
  s.stop();
});

const spinOut = () => out({ fm_hd_tpl: "{spin} job" });

test("working: only fm_hd is sent every tick with {spin} replaced by the clock's frame; it stops when not working and on stop()", async () => {
  const frames = symbolSet("unicode").spinner;
  const w = { on: true };
  const { s, reports, st } = rig({ working: () => w.on, tickMs: 10, frames, symbols: "unicode" }, spinOut);
  st.now = 250 * 3;
  s.request();
  await sleep(60);
  assert.deepEqual(reports[0].fm_meta, "$1", "the full report carries the other tokens");
  assert.equal(reports[0].fm_hd, `${frames[3]} job`, "and the animated header");
  const ticks = reports.filter((r) => Object.keys(r).join() === "fm_hd");
  assert.ok(ticks.length >= 2);
  assert.equal(ticks[0].fm_hd, `${spinnerFrame(frames, st.now)} job`);
  st.now += 250;
  await sleep(30);
  assert.equal(reports[reports.length - 1].fm_hd, `${frames[4]} job`);
  w.on = false;
  await sleep(30);
  const n = reports.length;
  await sleep(60);
  assert.equal(reports.length, n, "no tick while not working");
  w.on = true;
  s.request();
  await sleep(60);
  assert.ok(reports.length > n + 1, "working again: ticking");
  s.stop();
  const m = reports.length;
  await sleep(60);
  assert.equal(reports.length, m, "stop clears the timer");
});

test("ui.spinner:false sends static glyphs: no tick, no {spin} substitution", async () => {
  const { s, reports } = rig({ working: () => true, spinner: false, tickMs: 10 }, spinOut);
  s.request();
  await sleep(60);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fm_hd, "⏳⠀ job");
  s.stop();
});

test("a session that is not working never ticks, even with a spinner template", async () => {
  const { s, reports } = rig({ working: () => false, tickMs: 10 }, spinOut);
  s.request();
  await sleep(60);
  assert.equal(reports.length, 1);
  s.stop();
});
