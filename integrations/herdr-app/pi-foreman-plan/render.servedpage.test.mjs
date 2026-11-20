import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { pageUrlArgv, openerArgv, radarBinary } = await import("./model.js");
const agents = await import("../pi-foreman/model.js");
const { world } = stubs;

const SLOT0 = "/app/mods/pi-foreman-plan/cache/pages/slot-0.html";
const SERVED = "http://127.0.0.1:47317/AbCd_-09/plan.html";
const entry = (file) => ({ id: file.replace(/\.html$/, ""), kind: "plan", title: file, state: "draft", version: 1, at: "2026-11-06T10:00:00Z", file });
const sess = (key, hc, show) => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent: "", state: "working", show, children: [] });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);

function reset({ machine = null, props } = {}) {
  world.files = new Map([["/s/fm/pages/pages.json", JSON.stringify({ v: 1, pages: [entry("plan.html")], events: [] })], ["/s/fm/pages/plan.html", "<p>plan</p>"]]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.execCalls = [];
  world.platform = "macos"; world.props = props;
  const addr = machine ? `${machine}/t1` : "t1";
  world.shared = { "pi-foreman.radar": { machines: { [machine ?? "local"]: [sess("fm", "t1", { dir: "/s/fm" })] } } };
  world.agents = [{ address: addr, tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: addr }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: addr, shown: null, agent: addr, cwd: null };
}
async function open({ machine = null } = {}) {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  await settle();
  byId(m.render(cx), "page-plan").props.on_click(null, cx);
  await settle();
  return { m, cx };
}
test.afterEach(() => { world.platform = undefined; world.execFn = undefined; world.props = undefined; });
const urlCalls = () => world.execCalls.filter((c) => c[1][0] === "pages");
const openerCalls = () => world.execCalls.filter((c) => c[0] === "open");

test("a local page opens the URL `foreman pages url` printed; no slot copy is written", async () => {
  reset({ props: { foreman: "/opt/bin/foreman" } });
  world.execFn = (cmd) => (cmd === "/opt/bin/foreman" ? { code: 0, stdout: `${SERVED}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
  await open();
  assert.deepEqual(urlCalls(), [["/opt/bin/foreman", ["pages", "url", "/s/fm/pages/plan.html"], { timeout: 5000 }]]);
  assert.deepEqual(openerCalls(), [["open", [SERVED], { timeout: 10000 }]]);
  assert.deepEqual(world.writes, []);
  assert.deepEqual(world.notices, []);
});

for (const [name, answer] of [
  ["an empty answer", () => ({ code: 0, stdout: "\n", stderr: "" })],
  ["an exit error", () => ({ code: 1, stdout: SERVED, stderr: "" })],
  ["a thrown error", () => { throw new Error("cannot start foreman: program not found"); }],
  ["a non-http answer", () => ({ code: 0, stdout: "file:///etc/passwd\n", stderr: "" })],
  ["a javascript answer", () => ({ code: 0, stdout: "javascript:alert(1)\n", stderr: "" })],
]) {
  test(`${name}: today's slot copy opens`, async () => {
    reset();
    world.execFn = (cmd, args) => (args[0] === "pages" ? answer() : { code: 0, stdout: "", stderr: "" });
    await open();
    assert.deepEqual(world.writes, [[SLOT0, "<p>plan</p>"]]);
    assert.deepEqual(openerCalls(), [["open", [SLOT0], { timeout: 10000 }]]);
  });
}

test("a remote session never asks `foreman pages url`; the slot copy opens", async () => {
  reset({ machine: "box" });
  world.files = new Map([["/s/fm/pages/pages.json", JSON.stringify({ v: 1, pages: [entry("plan.html")], events: [] })], ["/s/fm/pages/plan.html", "<p>plan</p>"]]);
  world.execFn = () => ({ code: 0, stdout: `${SERVED}\n`, stderr: "" });
  await open({ machine: "box" });
  assert.deepEqual(urlCalls(), []);
});

test("pageUrlArgv: http and https only, no shell text; openerArgv stays https-only; radarBinary equals the Agents mod's", () => {
  assert.deepEqual(pageUrlArgv("darwin", SERVED), ["open", SERVED]);
  assert.deepEqual(pageUrlArgv("linux", "https://h.example/x/y.html"), ["xdg-open", "https://h.example/x/y.html"]);
  assert.deepEqual(pageUrlArgv("win32", SERVED), ["rundll32", "url.dll,FileProtocolHandler", SERVED]);
  for (const bad of ["file:///x", "javascript:1", "ftp://h/x", "http://", "http://h/x y", "http://h/\nx", "", null, `http://h/${"a".repeat(2100)}`]) assert.equal(pageUrlArgv("darwin", bad), null, String(bad));
  assert.equal(pageUrlArgv("freebsd", SERVED), null);
  assert.equal(openerArgv("darwin", SERVED), null);
  assert.equal(String(radarBinary), String(agents.radarBinary));
});
