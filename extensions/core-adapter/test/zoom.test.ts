// The click-to-enlarge snippet (zoom.ts): injectZoom placement and idempotence, the page server's served HTML (pageserver.ts `handle`) with the snippet
// once and before </body>, and the stored bytes, the plan hash and the CSP header left as they were. Driven directly, no socket.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { planHash, sha256 } from "../checkpoint.ts";
import { handle, pagesStateDir, registerRoot } from "../pageserver.ts";
import type { HandlerCtx, HostRules, Reply } from "../pageserver.ts";
import { ZOOM_MARKER, ZOOM_SNIPPET, injectZoom } from "../zoom.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PLAN = "<!doctype html><html><body><h1>Plan</h1><pre class=\"mermaid\">graph TD</pre></body></html>\n";
const NOTE = "<p>note with &auml;</p>";
const UTF8_PLAN = "<html><body><p>Grüße – plan</p></body></html>";

let tmp: string;
let stateDir: string;
let pages: string;
let id: string;
let hosts: HostRules = { bind: "127.0.0.1", baseHost: null };

const ctx = (): HandlerCtx => ({ stateDir, hosts: () => hosts, health: () => ({ key: "k".repeat(32), info: { pid: 1, version: "1.0.0", port: 1, bind: "127.0.0.1" } }), touch: () => {} });
const get = (p: string): Reply => handle(ctx(), "GET", p, "127.0.0.1:47317");
const text = (r: Reply): string => r.body.toString("utf8");
const count = (s: string, needle: string): number => s.split(needle).length - 1;

before(() => {
  tmp = fs.realpathSync(mkTestTmp("zoom-"));
  stateDir = pagesStateDir(path.join(tmp, "agent"));
  pages = path.join(tmp, "ws", "show", "sid", "pages");
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(pages, "plan.html"), PLAN);
  fs.writeFileSync(path.join(pages, "note-1.html"), NOTE);
  fs.writeFileSync(path.join(pages, "raw.html"), UTF8_PLAN);
  fs.writeFileSync(path.join(pages, "page.md"), "# Zoomed\n\nSee the diagram.\n");
  fs.writeFileSync(path.join(pages, "a.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const r = registerRoot(stateDir, pages, "dir");
  assert.ok(r);
  id = r;
});
after(() => rmTestTmp(tmp));

test("injectZoom puts the snippet once, right before the last </body", () => {
  const out = injectZoom("<html><body><p>x</p></body></html>");
  assert.equal(count(out, ZOOM_MARKER), 1);
  assert.equal(count(out, ZOOM_SNIPPET), 1);
  assert.equal(out, `<html><body><p>x</p>${ZOOM_SNIPPET}</body></html>`);
});

test("injectZoom appends the snippet when the page has no </body", () => {
  assert.equal(injectZoom("<h1>plan</h1>"), `<h1>plan</h1>${ZOOM_SNIPPET}`);
});

test("injectZoom matches </body> in any case and uses the last one", () => {
  assert.equal(injectZoom("<BODY>a</BODY>"), `<BODY>a${ZOOM_SNIPPET}</BODY>`);
  assert.equal(injectZoom("<body>a</Body><!-- </body> --></body>"), `<body>a</Body><!-- </body> -->${ZOOM_SNIPPET}</body>`);
});

test("injectZoom is idempotent: a second pass changes nothing", () => {
  const once = injectZoom(PLAN);
  assert.equal(injectZoom(once), once);
  assert.equal(count(injectZoom(injectZoom(NOTE)), ZOOM_MARKER), 1);
});

test("the snippet's script parses as JavaScript (compiled, not run)", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(ZOOM_SNIPPET)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test("the snippet hooks img and svg, makes no request and uses no http(s) URL", () => {
  assert.match(ZOOM_SNIPPET, /img/);
  assert.match(ZOOM_SNIPPET, /svg/);
  assert.doesNotMatch(ZOOM_SNIPPET, /https?:\/\//);
  assert.doesNotMatch(ZOOM_SNIPPET, /[^\x00-\x7f]/);
  // 7168: the wrapper variants (block, percentage, centred) and the focus return grew the snippet from 4096 (see zoom-fit.test.ts)
  assert.ok(Buffer.byteLength(ZOOM_SNIPPET) < 7168, "snippet stays small");
});

test("the overlay sizes from visualViewport and keeps a near-opaque backdrop", () => {
  assert.match(ZOOM_SNIPPET, /visualViewport/);
  assert.match(ZOOM_SNIPPET, /rgba\(0,0,0,\.9\)/);
  assert.match(ZOOM_SNIPPET, /opacity:1!important/);
});

test("served HTML pages carry the snippet exactly once, before </body> when there is one", () => {
  for (const name of ["plan.html", "note-1.html", "raw.html", "page.md"]) {
    const r = get(`/${id}/${name}`);
    assert.equal(r.status, 200, name);
    assert.match(r.headers["Content-Type"], /^text\/html/, name);
    const body = text(r);
    assert.equal(count(body, ZOOM_MARKER), 1, name);
    const close = body.toLowerCase().lastIndexOf("</body");
    if (close >= 0) assert.ok(body.indexOf(ZOOM_MARKER) < close, name);
    assert.equal(r.headers["Content-Length"], String(r.body.length), name);
  }
});

test("the served plan page is the stored page with the snippet added", () => {
  assert.equal(text(get(`/${id}/plan.html`)), PLAN.replace("</body>", `${ZOOM_SNIPPET}</body>`));
  assert.equal(text(get(`/${id}/note-1.html`)), `${NOTE}${ZOOM_SNIPPET}`);
});

test("non-HTML files are served byte for byte, without the snippet", () => {
  const r = get(`/${id}/a.svg`);
  assert.equal(r.status, 200);
  assert.equal(text(r), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
});

test("the bytes of a served HTML page survive the round trip (UTF-8 kept)", () => {
  const body = get(`/${id}/raw.html`).body;
  assert.ok(body.includes(Buffer.from("Grüße – plan", "utf8")));
  assert.equal(body.toString("utf8"), UTF8_PLAN.replace("</body>", `${ZOOM_SNIPPET}</body>`));
});

test("the stored file and its plan hash are unchanged by serving", () => {
  const file = path.join(pages, "plan.html");
  const stored = fs.readFileSync(file);
  const hashBefore = planHash("plan.html", stored);
  get(`/${id}/plan.html`);
  get(`/${id}/plan.html`);
  const stillStored = fs.readFileSync(file);
  assert.deepEqual(stillStored, stored);
  assert.equal(planHash("plan.html", stillStored), hashBefore);
  assert.equal(hashBefore, sha256(stored));
  assert.equal(count(stillStored.toString("utf8"), ZOOM_MARKER), 0);
});

test("the sandbox CSP header is unchanged on HTML pages", () => {
  for (const name of ["plan.html", "page.md", "note-1.html"]) {
    assert.equal(get(`/${id}/${name}`).headers["Content-Security-Policy"], "sandbox allow-scripts allow-popups", name);
  }
});
