import test from "node:test";
import assert from "node:assert/strict";
import { parsePages, chipText, pageOpenerArgv, slotPath, dirFileUrl, rewriteRelative, PAGE_FILE } from "./model.js";

const entry = (file, o = {}) => ({ id: file.replace(/\.html$/, ""), kind: "plan", title: "T", state: "draft", version: 1, at: "2026-11-06T10:00:00Z", file, ...o });
const idx = (pages, events = []) => JSON.stringify({ v: 1, pages, events });

test("pages.json: only plan.html, result.html and note-<n>.html survive; planted names are dropped", () => {
  const bad = ["../plan.html", "..\\plan.html", "/etc/passwd", "plan.html/", "plan.htm", "plan.html\n", "note-.html", "note-1234567.html", "note-1.HTML", "sub/plan.html", "plan.html ", "result.html.x", "", "note-1/../plan.html"];
  const names = ["plan.html", "result.html", "note-1.html", "note-999999.html"];
  const r = parsePages(idx([...bad.map((f) => entry(f)), ...names.map((f) => entry(f))]));
  assert.deepEqual(r.pages.map((p) => p.file).sort(), [...names].sort());
  for (const f of names) assert.ok(PAGE_FILE.test(f));
  for (const f of bad) assert.ok(!PAGE_FILE.test(f), JSON.stringify(f));
});

test("pages.json: id and kind come from the file name, not the entry; duplicates and bad shapes are dropped", () => {
  const r = parsePages(idx([
    { ...entry("note-2.html"), id: "../x", kind: "plan" },
    entry("note-2.html", { title: "dup" }),
    "nope", null, { file: 5 }, { file: "plan.html", title: 7, state: {}, version: -1, at: "bad" },
  ]));
  assert.deepEqual(r.pages.map((p) => [p.id, p.kind, p.file]), [["note-2", "note", "note-2.html"], ["plan", "plan", "plan.html"]]);
  const plan = r.pages.find((p) => p.id === "plan");
  assert.deepEqual([plan.title, plan.state, plan.version, plan.at], ["", "", 0, null]);
});

test("pages.json: newest first, strings cleaned and capped, events kept in order and capped at 50", () => {
  const r = parsePages(idx([
    entry("note-1.html", { at: "2026-11-06T10:00:00Z" }), entry("plan.html", { at: "2026-11-06T12:00:00Z", version: 2 }), entry("note-2.html", { at: "2026-11-06T11:00:00Z", title: "a\u0000b\nc" + "x".repeat(500) }),
  ], Array.from({ length: 60 }, (_, i) => ({ at: "2026-11-06T10:00:00Z", kind: "k", text: `e${i}` }))));
  assert.deepEqual(r.pages.map((p) => p.id), ["plan", "note-2", "note-1"]);
  assert.ok(r.pages[1].title.startsWith("a b c") && r.pages[1].title.length === 120);
  assert.equal(r.events.length, 50);
  assert.equal(r.events[0].text, "e10");
  assert.equal(r.events.at(-1).text, "e59");
});

test("pages.json: not an index answers null", () => {
  for (const t of ["nope", "[]", "{}", JSON.stringify({ v: 2, pages: [] }), JSON.stringify({ v: 1 })]) assert.equal(parsePages(t), null, t);
  assert.deepEqual(parsePages(JSON.stringify({ v: 1, pages: [] })), { pages: [], events: [] });
});

test("the state chip: kind, version, state; a result has no version", () => {
  assert.equal(chipText({ kind: "plan", version: 3, state: "waits for you" }), "plan v3 · waits for you");
  assert.equal(chipText({ kind: "result", version: 1, state: "written" }), "result · written");
  assert.equal(chipText({ kind: "note", version: 2, state: "" }), "note v2");
});

const HOME = "/app";
const slot = (n) => `/app/mods/pi-foreman-plan/cache/pages/slot-${n}.html`;

test("pageOpenerArgv: the exact slot path only, argv without a shell", () => {
  for (let n = 0; n < 8; n++) {
    assert.deepEqual(pageOpenerArgv("linux", HOME, slot(n)), ["xdg-open", slot(n)]);
    assert.deepEqual(pageOpenerArgv("darwin", HOME, slot(n)), ["open", slot(n)]);
  }
  assert.deepEqual(pageOpenerArgv("win32", "C:\\h", "C:\\h\\mods\\pi-foreman-plan\\cache\\pages\\slot-3.html"), ["rundll32", "url.dll,FileProtocolHandler", "C:\\h\\mods\\pi-foreman-plan\\cache\\pages\\slot-3.html"]);
  assert.equal(slotPath(HOME, 8), null);
  assert.equal(slotPath(HOME, -1), null);
});

test("pageOpenerArgv: outside paths, .., other extensions, slot 8, prefix tricks and other platforms answer null", () => {
  const no = [
    "/etc/passwd", "/app/mods/pi-foreman-plan/cache/pages/slot-0.htm", "/app/mods/pi-foreman-plan/cache/pages/slot-8.html", "/app/mods/pi-foreman-plan/cache/pages/slot-00.html",
    "/app/mods/pi-foreman-plan/cache/pages/../pages/slot-0.html", "/app/mods/pi-foreman-plan/cache/pages-x/slot-0.html", "/app/mods/pi-foreman-plan/cache/pages/x/slot-0.html",
    "/app/../etc/mods/pi-foreman-plan/cache/pages/slot-0.html", "/appx/mods/pi-foreman-plan/cache/pages/slot-0.html", "/app/mods/pi-foreman-plan/cache/pages/slot-0.html/",
    "/app/mods/pi-foreman-plan/cache/pages/slot-0.html\n", "/app/mods/pi-foreman-plan/cache/slot-0.html", "mods/pi-foreman-plan/cache/pages/slot-0.html", "", "https://example.org/x",
    "/APP/mods/pi-foreman-plan/cache/pages/slot-0.html", "/app/MODS/pi-foreman-plan/cache/pages/slot-0.html",
  ];
  for (const p of no) assert.equal(pageOpenerArgv("linux", HOME, p), null, JSON.stringify(p));
  assert.equal(pageOpenerArgv("freebsd", HOME, slot(0)), null);
  assert.equal(pageOpenerArgv("linux", HOME, undefined), null);
  assert.equal(pageOpenerArgv("linux", undefined, slot(0)), null);
  assert.equal(pageOpenerArgv("linux", "app", "app/mods/pi-foreman-plan/cache/pages/slot-0.html"), null, "a relative home");
  assert.equal(pageOpenerArgv("linux", "/a/../b", "/a/../b/mods/pi-foreman-plan/cache/pages/slot-0.html"), null, "a home with ..");
});

test("pageOpenerArgv: the path compare ignores case on macOS and Windows only", () => {
  const up = "/APP/Mods/Pi-Foreman-Plan/Cache/Pages/Slot-0.HTML";
  assert.deepEqual(pageOpenerArgv("darwin", HOME, up), ["open", up]);
  assert.equal(pageOpenerArgv("linux", HOME, up), null);
  const win = "c:/H/MODS/pi-foreman-plan/cache/pages/SLOT-1.html";
  assert.deepEqual(pageOpenerArgv("win32", "C:\\h", win), ["rundll32", "url.dll,FileProtocolHandler", win], "either separator, any case");
  assert.equal(pageOpenerArgv("linux", "C:\\h", win), null);
  assert.equal(pageOpenerArgv("win32", "C:\\h", "C:\\h\\mods\\pi-foreman-plan\\cache\\pages\\..\\slot-1.html"), null);
  assert.equal(pageOpenerArgv("win32", "C:\\h", "C:\\h2\\mods\\pi-foreman-plan\\cache\\pages\\slot-1.html"), null);
});

test("dirFileUrl: an absolute folder as an encoded file URL with a trailing slash", () => {
  assert.equal(dirFileUrl("/s/fm/pages"), "file:///s/fm/pages/");
  assert.equal(dirFileUrl("/s/a b/it's/pages/"), "file:///s/a%20b/it%27s/pages/");
  assert.equal(dirFileUrl("C:\\Users\\me\\pages"), "file:///C:/Users/me/pages/");
  assert.equal(dirFileUrl("rel/pages"), null);
});

const BASE = "file:///s/fm/pages/";

test("rewriteRelative: relative src and poster values become file URLs; nothing else changes", () => {
  const html = '<img src="a b/x.png"><video src=\'v.mp4\' poster="p.png?x=1#f"></video>';
  assert.equal(rewriteRelative(html, BASE),
    `<img src="${BASE}a%20b/x.png"><video src='${BASE}v.mp4' poster="${BASE}p.png?x=1#f"></video>`);
  assert.equal(rewriteRelative('<img src="../d/x.png">', BASE), `<img src="${BASE}../d/x.png">`);
});

test("rewriteRelative: absolute, scheme, # and empty values, links, srcset, data-src, CSS url() stay untouched", () => {
  const same = [
    '<img src="/abs/x.png">', '<img src="//host/x.png">', '<img src="#top">', '<img src="">', '<img src="https://e.org/x.png">',
    '<img src="data:image/svg+xml;base64,AAAA">', '<img src="file:///etc/passwd">', '<img src="javascript:alert(1)">',
    '<a href="rel/page.html">x</a>', '<img srcset="a.png 1x, b.png 2x">', '<img data-src="a.png">', '<div style="background:url(a.png)"></div>',
    '<link rel="stylesheet" href="s.css">', '<img src=unquoted.png>', "<p>no attributes</p>",
  ];
  for (const h of same) assert.equal(rewriteRelative(h, BASE), h, h);
});

test("rewriteRelative: the scheme and absolute test runs on the trimmed value", () => {
  for (const h of ['<img src=" https://e.org/a.png">', '<img src=" /abs.png">', '<img src=" javascript:alert(1)">', '<img src="\t//host/x.png">']) {
    assert.equal(rewriteRelative(h, BASE), h, h);
  }
  assert.equal(rewriteRelative('<img src=" a.png">', BASE), `<img src="${BASE}%20a.png">`);
});

test("rewriteRelative: an encoded value cannot leave its attribute", () => {
  const out = rewriteRelative('<img src="x&quot;onerror=1 y\'z<q>.png">', BASE);
  assert.ok(!/[<>']/.test(out.slice(out.indexOf("src=") + 5, out.lastIndexOf('"'))));
  assert.ok(out.startsWith(`<img src="${BASE}x&quot;onerror=1%20y%27z%3Cq%3E.png"`));
  assert.equal(rewriteRelative("<img src='a%zz%20b.png'>", BASE), `<img src='${BASE}a%25zz%20b.png'>`);
});
