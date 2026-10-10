import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SPINNER_FRAMES, SidebarLive, frameArgv, installSidebarLive, sidebarGate, type SidebarDeps } from "../sidebarlive.ts";
import type { LiveStateName } from "../livestate.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(over: Partial<SidebarDeps> = {}) {
  const pushes: string[][] = [];
  const herdr: string[][] = [];
  const order: string[] = [];
  const st = { state: "idle" as LiveStateName, inflight: 0, maxInflight: 0, delay: 20 };
  const d: SidebarDeps = {
    pane: "w1:p1",
    sessionId: "sid",
    agentDir: "/a",
    symbols: "nerd",
    spinner: true,
    push: (args, done) => {
      pushes.push(args);
      order.push("push");
      st.inflight++;
      st.maxInflight = Math.max(st.maxInflight, st.inflight);
      setTimeout(() => {
        st.inflight--;
        done();
      }, st.delay);
    },
    herdr: (a) => herdr.push(a),
    flush: () => order.push("flush"),
    state: () => st.state,
    finish: () => order.push("finish"),
    gapMs: 100,
    refreshMs: 10_000,
    spinMs: 30,
    ...over,
  };
  return { s: new SidebarLive(d), pushes, herdr, order, st };
}

test("an event flushes the presence file, then pushes with the session args", () => {
  const { s, pushes, order } = rig();
  s.request();
  assert.deepEqual(order, ["flush", "push"]);
  assert.deepEqual(pushes[0], ["push", "--session", "sid", "--pane", "w1:p1", "--agent-dir", "/a", "--symbols", "nerd"]);
  s.stop();
});

test("a burst of 10 events: one push now, one trailing, never two in flight", async () => {
  const { s, pushes, st } = rig();
  for (let i = 0; i < 10; i++) s.request();
  await sleep(400);
  assert.equal(pushes.length, 2);
  assert.equal(st.maxInflight, 1);
  s.request();
  assert.equal(pushes.length, 3, "gap passed: starts at once");
  s.request();
  await sleep(10);
  assert.equal(pushes.length, 3, "in flight: waits");
  await sleep(250);
  assert.equal(pushes.length, 4, "one trailing push");
  s.stop();
});

test("a push slower than the gap: one trailing push, then quiet", async () => {
  const { s, pushes, st } = rig();
  st.delay = 150;
  s.request();
  await sleep(20);
  s.request();
  await sleep(700);
  assert.equal(pushes.length, 2);
  assert.equal(st.maxInflight, 1);
  s.stop();
});

test("shutdown pushes --final (not --clear) after marking the presence done, and stops later pushes", async () => {
  const { s, pushes, order } = rig();
  s.request();
  await sleep(50);
  s.stop();
  assert.deepEqual(order.slice(-3), ["finish", "flush", "push"]);
  assert.equal(pushes.at(-1)!.at(-1), "--final");
  assert.ok(!pushes.some((p) => p.includes("--clear")));
  const n = pushes.length;
  s.request();
  await sleep(150);
  assert.equal(pushes.length, n);
});

test("spinner cycles in order while working and stops at blocked and idle", async () => {
  const { s, herdr, st } = rig({ spinMs: 25 });
  st.state = "working";
  s.request();
  await sleep(140);
  const frames = herdr.map((a) => a[a.indexOf("--token") + 1].slice("fm_sym=".length));
  assert.ok(frames.length >= 3);
  const idx = frames.map((f) => SPINNER_FRAMES.indexOf(f));
  assert.ok(idx.every((i) => i >= 0));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] === idx[i - 1] || idx[i] === (idx[i - 1] + 1) % 8, "in order");
  assert.deepEqual(herdr[0], frameArgv("w1:p1", frames[0]));
  st.state = "blocked";
  s.request();
  await sleep(40);
  const n = herdr.length;
  await sleep(100);
  assert.equal(herdr.length, n);
  s.stop();
});

test("ui.spinner false: no frames", async () => {
  const { s, herdr, st } = rig({ spinner: false });
  st.state = "working";
  s.request();
  await sleep(150);
  assert.equal(herdr.length, 0);
  s.stop();
});

test("gate: needs HERDR_ENV=1, a pane, tui, python and the script", () => {
  const me = fileURLToPathSelf();
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
  assert.equal(sidebarGate(env, "tui", "py", me), true);
  assert.equal(sidebarGate({ HERDR_PANE_ID: "w1:p1" }, "tui", "py", me), false);
  assert.equal(sidebarGate({ ...env, HERDR_PANE_ID: " " }, "tui", "py", me), false);
  assert.equal(sidebarGate(env, "rpc", "py", me), false);
  assert.equal(sidebarGate(env, "tui", null, me), false);
  assert.equal(sidebarGate(env, "tui", "py", me + ".missing"), false);
});

function fileURLToPathSelf(): string {
  return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

test("install: without HERDR_ENV nothing starts (no onChange subscription)", () => {
  let subscribed = 0;
  const handlers: Record<string, () => Promise<void>> = {};
  const pi = { on: (n: string, h: () => Promise<void>) => void (handlers[n] = h) } as never;
  const live = { onChange: () => (subscribed++, () => {}), flush() {}, stop() {}, stateName: "idle" as LiveStateName };
  const sl = installSidebarLive(pi, { env: {} });
  sl.start({ mode: "tui" } as never, { python: "py", pkgRoot: path.resolve(fileURLToPathSelf(), "..", "..", "..", ".."), agentDir: "/a", sessionId: "s", live });
  assert.equal(subscribed, 0);
});

test("install with a fake herdr binary: the spinner runs the real herdr argv", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbl-"));
  try {
    const log = path.join(dir, "argv.jsonl");
    const bin = path.join(dir, "herdr");
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`, { mode: 0o755 });
    const script = path.join(dir, "integrations", "herdr", "pi-foreman-sidebar");
    fs.mkdirSync(script, { recursive: true });
    fs.writeFileSync(path.join(script, "sidebar.py"), "");
    const py = path.join(dir, "py");
    fs.writeFileSync(py, `#!${process.execPath}\n`, { mode: 0o755 });
    const cbs: (() => void)[] = [];
    const live = { onChange: (cb: () => void) => (cbs.push(cb), () => {}), flush() {}, stop() {}, stateName: "working" as LiveStateName };
    let shutdown: () => Promise<void> = async () => {};
    const pi = { on: (_n: string, h: () => Promise<void>) => void (shutdown = h) } as never;
    const sl = installSidebarLive(pi, { env: { HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_BIN: bin } });
    sl.start({ mode: "tui" } as never, { python: py, pkgRoot: dir, agentDir: dir, sessionId: "s", live });
    assert.equal(cbs.length, 1);
    await sleep(1600);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    assert.ok(lines.length >= 1);
    assert.deepEqual(lines[0].slice(0, 5), ["pane", "report-metadata", "w9:p9", "--source", "plugin:pi-foreman.sidebar"]);
    assert.ok(lines[0].some((a) => a.startsWith("fm_sym=")));
    live.stateName = "idle";
    cbs[0]();
    await shutdown();
  } finally {
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
