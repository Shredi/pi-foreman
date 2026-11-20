import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../pi-foreman/stubs-hooks.mjs", import.meta.url);
const stubs = await import("../pi-foreman/stubs.mjs");
const { default: Mod } = await import("./main.js");
const { world } = stubs;
// the `<foreman> pages url <file>` call of the served-page path is not an opener call
const execs = () => world.execCalls.filter((c) => !(c[1][0] === "pages" && c[1][1] === "url"));

const SLOT = (n) => `/app/mods/pi-foreman-plan/cache/pages/slot-${n}.html`;
const entry = (file, o = {}) => ({ id: file.replace(/\.html$/, ""), kind: "plan", title: file, state: "draft", version: 1, at: "2026-11-06T10:00:00Z", file, ...o });
const sess = (key, hc, show) => ({ key, kind: "session", name: key, hcTerminal: hc, pid: null, parent: "", state: "working", show, children: [] });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const walk = (el, out = []) => { if (el && typeof el === "object") { out.push(el); for (const k of el.kids ?? []) walk(k, out); } return out; };
const byId = (el, id) => walk(el).find((e) => e.props?.id === id);

function reset(pages, { machine = null } = {}) {
  const index = JSON.stringify({ v: 1, pages, events: [] });
  world.files = new Map([["/s/fm/pages/pages.json", index]]);
  world.reads = []; world.writes = []; world.runCalls = []; world.notices = []; world.execCalls = [];
  world.platform = "macos"; world.execFn = () => ({ code: 0, stdout: "", stderr: "" });
  const addr = machine ? `${machine}/t1` : "t1";
  world.shared = { "pi-foreman.radar": { machines: { [machine ?? "local"]: [sess("fm", "t1", { dir: "/s/fm" })] } } };
  world.agents = [{ address: addr, tab: "tabA", pane: "p1" }];
  world.panes = [{ pane: "p1", tab: "tabA", terminal: addr }];
  world.terminals = [];
  world.focus = { space: "s", tab: "tabA", pane: "p1", terminal: addr, shown: null, agent: addr, cwd: null };
}
async function boot() {
  const cx = { notified: 0, spawn(f) { f(cx); }, notify() { cx.notified++; }, timer: { every() {} }, sleep: () => new Promise(() => {}) };
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
  await settle();
  return { m, cx };
}
const click = async (m, cx, id) => { byId(m.render(cx), `page-${id}`).props.on_click(null, cx); await settle(); };
test.afterEach(() => { world.platform = undefined; world.execFn = undefined; });

test("a local page is read, its relative src and poster are made absolute, and only the slot copy is opened", async () => {
  reset([entry("plan.html")]);
  world.files.set("/s/fm/pages/plan.html", '<img src="d/a b.png"><video poster="p.png" src="https://e.org/v.mp4"></video><a href="x.html">x</a><img src="#a"><img src="/abs.png">');
  const { m, cx } = await boot();
  await click(m, cx, "plan");
  assert.deepEqual(world.writes, [[SLOT(0), '<img src="file:///s/fm/pages/d/a%20b.png"><video poster="file:///s/fm/pages/p.png" src="https://e.org/v.mp4"></video><a href="x.html">x</a><img src="#a"><img src="/abs.png">']]);
  assert.deepEqual(execs(), [["open", [SLOT(0)], { timeout: 10000 }]]);
  assert.deepEqual(world.notices, []);
});

test("the copies go round the eight slots and overwrite", async () => {
  reset([entry("plan.html")]);
  world.files.set("/s/fm/pages/plan.html", "<p>v</p>");
  const { m, cx } = await boot();
  for (let i = 0; i < 9; i++) await click(m, cx, "plan");
  assert.deepEqual(world.writes.map((w) => w[0]), [0, 1, 2, 3, 4, 5, 6, 7, 0].map(SLOT));
  assert.deepEqual(execs().map((c) => c[1][0]), [0, 1, 2, 3, 4, 5, 6, 7, 0].map(SLOT));
});

test("the platform opener follows the platform; Linux and Windows argv", async () => {
  reset([entry("plan.html")]);
  world.files.set("/s/fm/pages/plan.html", "<p>v</p>");
  const { m, cx } = await boot();
  world.platform = "linux"; await click(m, cx, "plan");
  world.platform = "windows"; await click(m, cx, "plan");
  assert.deepEqual(execs().map((c) => [c[0], c[1]]), [["xdg-open", [SLOT(0)]], ["rundll32", ["url.dll,FileProtocolHandler", SLOT(1)]]]);
});

test("a remote page is read on its machine and copied as it is", async () => {
  reset([entry("plan.html")], { machine: "box" });
  world.files.set("/s/fm/pages/plan.html", '<img src="d/a.png">');
  const { m, cx } = await boot();
  assert.ok(world.reads.some(([p, on]) => p === "/s/fm/pages/pages.json" && on === "box"), "the index is read on the machine");
  await click(m, cx, "plan");
  assert.ok(world.reads.some(([p, on]) => p === "/s/fm/pages/plan.html" && on === "box"), "the page is read on the machine");
  assert.deepEqual(world.writes, [[SLOT(0), '<img src="d/a.png">']], "no rewrite, written locally");
  assert.deepEqual(execs().map((c) => c[1]), [[SLOT(0)]]);
  assert.ok(!world.reads.some(([p, on]) => p === SLOT(0) && on === "box"));
});

test("an index entry with another file name is not listed and its path is never read", async () => {
  reset([entry("plan.html"), entry("../../../etc/passwd"), entry("..\\x.html"), entry("evil.html"), entry("/etc/passwd")]);
  world.files.set("/etc/passwd", "root:x");
  world.files.set("/s/fm/pages/evil.html", "<p>evil</p>");
  const { m, cx } = await boot();
  const tree = m.render(cx);
  assert.deepEqual(walk(tree).filter((e) => String(e.props?.id ?? "").startsWith("page-")).map((e) => e.props.id), ["page-plan"]);
  assert.ok(!world.reads.some(([p]) => /passwd|evil|\.\./.test(p)));
  // even a record forced past the parser is refused before a path is built
  m.openPage(m.cur.tabs[0], { id: "x", file: "../evil.html", at: null, version: 0 }, cx); await settle();
  assert.ok(!world.reads.some(([p]) => /evil/.test(p)));
  assert.deepEqual(world.writes, []);
});

test("a page that cannot be read or is over 1 MiB raises one notice each and writes nothing", async () => {
  reset([entry("plan.html")]);
  const { m, cx } = await boot();
  await click(m, cx, "plan");
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].level, "error");
  assert.match(world.notices[0].body, /could not be read/);
  world.files.set("/s/fm/pages/plan.html", "x".repeat(1024 * 1024 + 1));
  await click(m, cx, "plan");
  assert.match(world.notices[1].body, /1 MiB/);
  assert.equal(world.notices.length, 2);
  assert.deepEqual(world.writes, []);
  assert.deepEqual(execs(), []);
});

test("an opener that fails raises one notice with its failure line", async () => {
  reset([entry("plan.html")]);
  world.files.set("/s/fm/pages/plan.html", "<p>v</p>");
  world.execFn = () => ({ code: 3, stdout: "", stderr: "no browser\nsecond" });
  const { m, cx } = await boot();
  await click(m, cx, "plan");
  assert.equal(world.notices.length, 1);
  assert.equal(world.notices[0].title, "Could not open the page");
  assert.match(world.notices[0].body, /exit 3: no browser/);
});
