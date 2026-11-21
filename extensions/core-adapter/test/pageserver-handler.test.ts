// The page server's request handler (pageserver.ts `handle`): root ids, path confinement, listing, methods, Host check, extensions, size cap, markdown, headers.
// Driven directly, no socket.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_FILE_BYTES, handle, hostAllowed, pagesStateDir, registerRoot, rootsDir, servedUrl } from "../pageserver.ts";
import type { HandlerCtx, HostRules, Reply } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

let tmp: string;
let stateDir: string;
let pages: string;
let id: string;
let hosts: HostRules = { bind: "127.0.0.1", baseHost: null };
let touched = 0;

const ctx = (): HandlerCtx => ({ stateDir, hosts: () => hosts, health: () => ({ key: "k".repeat(32), info: { pid: 1, version: "1.0.0", port: 1, bind: "127.0.0.1" } }), touch: () => { touched++; } });
const get = (p: string, host = "127.0.0.1:47317", method = "GET"): Reply => handle(ctx(), method, p, host);
const text = (r: Reply): string => r.body.toString("utf8");

before(() => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-handler-"));
  stateDir = pagesStateDir(path.join(tmp, "agent"));
  pages = path.join(tmp, "ws", "show", "sid", "pages");
  fs.mkdirSync(path.join(pages, "sub"), { recursive: true });
  fs.writeFileSync(path.join(pages, "plan.html"), "<h1>plan</h1>");
  fs.writeFileSync(path.join(pages, "sub", "note.txt"), "plain");
  fs.writeFileSync(path.join(pages, "pic.png"), "png");
  fs.writeFileSync(path.join(pages, "a.svg"), "<svg/>");
  fs.writeFileSync(path.join(pages, "a.css"), "x{}");
  fs.writeFileSync(path.join(pages, "a.jpg"), "j");
  fs.writeFileSync(path.join(pages, "a.gif"), "g");
  fs.writeFileSync(path.join(pages, "a.jpeg"), "j");
  fs.writeFileSync(path.join(pages, "script.js"), "alert(1)");
  fs.writeFileSync(path.join(pages, "data.json"), "{}");
  fs.writeFileSync(path.join(pages, ".hidden.html"), "h");
  fs.writeFileSync(path.join(pages, "page.md"), "# Hello title\n\nBody **bold**.\n");
  const r = registerRoot(stateDir, pages, "dir");
  assert.ok(r);
  id = r;
});
after(() => rmTestTmp(tmp));

test("a right id serves the page; a missing, wrong or short id gives 404", () => {
  assert.equal(get(`/${id}/plan.html`).status, 200);
  assert.equal(text(get(`/${id}/plan.html`)), "<h1>plan</h1>");
  assert.equal(get("/plan.html").status, 404);
  assert.equal(get("/").status, 404);
  assert.equal(get(`/${"a".repeat(26)}/plan.html`).status, 404);
  assert.equal(get(`/${id.slice(0, 25)}/plan.html`).status, 404);
  assert.equal(get(`/${id}`).status, 404);
  assert.equal(get(`/${id.toLowerCase() === id ? id.toUpperCase() : id.toLowerCase()}/plan.html`).status, 404);
  assert.equal(text(get(`/${"a".repeat(26)}/plan.html`)), "not found\n");
});

test("a root id is looked up by file name, never used as a path", () => {
  assert.equal(get(`/..%2Fagent/plan.html`).status, 404);
  assert.equal(get(`/${"..".repeat(21)}x/plan.html`).status, 404);
});

test("path confinement: dot segments, encoded dots, backslash, colon, NUL, leading dot", () => {
  fs.writeFileSync(path.join(tmp, "outside.html"), "secret");
  for (const p of ["../outside.html", "%2e%2e/outside.html", "%2E%2E/outside.html", "sub/../plan.html", "./plan.html", "sub%2f..%2fplan.html", "..%5Coutside.html", "sub%5Cnote.txt", "C%3A/x.html", "plan.html:stream", "plan%00.html", ".hidden.html", "sub/.x.txt", "%252e%252e/outside.html", "sub//note.txt", "%zz.html"]) {
    assert.equal(get(`/${id}/${p}`).status, 404, p);
  }
  assert.equal(get(`/${id}/sub/note.txt`).status, 200);
});

test("no directory listing: a directory, the root and a trailing slash give 404", () => {
  assert.equal(get(`/${id}/sub`).status, 404);
  assert.equal(get(`/${id}/sub/`).status, 404);
  assert.equal(get(`/${id}/`).status, 404);
});

test("GET and HEAD only: 405 otherwise; HEAD has the headers and no body", () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const r = get(`/${id}/plan.html`, "127.0.0.1", m);
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.Allow, "GET, HEAD");
  }
  const h = get(`/${id}/plan.html`, "127.0.0.1", "HEAD");
  assert.equal(h.status, 200);
  assert.equal(h.headers["Content-Length"], "13");
});

test("Host check: loopback names, the bind address and the baseUrl host (any port) pass; others give 404", () => {
  const ok = (h: string | undefined): number => handle(ctx(), "GET", `/${id}/plan.html`, h).status;
  for (const h of ["127.0.0.1", "127.0.0.1:1", "localhost:47317", "LOCALHOST", "[::1]:47317"]) assert.equal(ok(h), 200, h);
  for (const h of ["evil.example", "evil.example:47317", "127.0.0.1.evil.example", "", undefined, "10.0.0.5:47317", "localhost.evil.example"]) assert.equal(ok(h), 404, String(h));
  hosts = { bind: "100.64.1.2", baseHost: "box.vpn.example" };
  try {
    for (const h of ["100.64.1.2:47317", "box.vpn.example", "box.vpn.example:8443"]) assert.equal(ok(h), 200, h);
    assert.equal(ok("evil.example"), 404);
    assert.equal(hostAllowed("[fd00::1]:1", { bind: "fd00::1", baseHost: null }), true);
    assert.equal(hostAllowed("[fd00::2]:1", { bind: "fd00::1", baseHost: null }), false);
  } finally {
    hosts = { bind: "127.0.0.1", baseHost: null };
  }
});

test("extension allow-list: html md svg png jpg jpeg gif css txt serve, others give 404", () => {
  const types: Record<string, string> = { "plan.html": "text/html", "a.svg": "image/svg+xml", "pic.png": "image/png", "a.jpg": "image/jpeg", "a.jpeg": "image/jpeg", "a.gif": "image/gif", "a.css": "text/css", "sub/note.txt": "text/plain", "page.md": "text/html" };
  for (const [name, type] of Object.entries(types)) {
    const r = get(`/${id}/${name}`);
    assert.equal(r.status, 200, name);
    assert.ok(r.headers["Content-Type"].startsWith(type), name);
  }
  for (const name of ["script.js", "data.json"]) assert.equal(get(`/${id}/${name}`).status, 404, name);
});

test("a markdown page is rendered by renderPage, with the page's title", () => {
  const r = get(`/${id}/page.md`);
  const body = text(r);
  assert.match(body, /<!doctype html>/i);
  assert.match(body, /<h1>Hello title<\/h1>/);
  assert.match(body, /<strong>bold<\/strong>/);
  assert.doesNotMatch(body, /\*\*bold\*\*/);
});

test("every answer carries the sandbox CSP, no-referrer, nosniff and no-store", () => {
  for (const r of [get(`/${id}/plan.html`), get(`/${id}/nope.html`), get("/x"), get(`/${id}/plan.html`, "127.0.0.1", "POST"), get(`/${id}/plan.html`, "evil.example"), get(`/${id}/page.md`)]) {
    assert.equal(r.headers["Content-Security-Policy"], "sandbox allow-scripts allow-popups");
    assert.equal(r.headers["Referrer-Policy"], "no-referrer");
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(r.headers["Cache-Control"], "no-store");
  }
});

test("size cap: a file over 8 MiB gives 404, one at the cap serves", () => {
  fs.writeFileSync(path.join(pages, "big.txt"), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
  fs.writeFileSync(path.join(pages, "edge.txt"), Buffer.alloc(MAX_FILE_BYTES, 97));
  assert.equal(get(`/${id}/big.txt`).status, 404);
  assert.equal(get(`/${id}/edge.txt`).status, 200);
});

test("a hard-linked file gives 404", () => {
  fs.writeFileSync(path.join(tmp, "linked-orig.html"), "linked");
  fs.linkSync(path.join(tmp, "linked-orig.html"), path.join(pages, "linked.html"));
  assert.equal(get(`/${id}/linked.html`).status, 404);
});

test("a symlink inside the root (file or directory) gives 404", { skip: posixOnly }, () => {
  fs.writeFileSync(path.join(tmp, "target.html"), "target");
  fs.symlinkSync(path.join(tmp, "target.html"), path.join(pages, "link.html"));
  fs.mkdirSync(path.join(tmp, "outdir"));
  fs.writeFileSync(path.join(tmp, "outdir", "in.txt"), "in");
  fs.symlinkSync(path.join(tmp, "outdir"), path.join(pages, "linkdir"));
  assert.equal(get(`/${id}/link.html`).status, 404);
  assert.equal(get(`/${id}/linkdir/in.txt`).status, 404);
});

test("a root dir replaced by a symlink to another dir stops serving", { skip: posixOnly }, () => {
  const real = path.join(tmp, "swap", "pages");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "plan.html"), "swap");
  const sid = registerRoot(stateDir, real, "dir");
  assert.ok(sid);
  assert.equal(get(`/${sid}/plan.html`).status, 200);
  const other = path.join(tmp, "swap-other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "plan.html"), "other");
  fs.renameSync(real, path.join(tmp, "swap", "gone"));
  fs.symlinkSync(other, real);
  assert.equal(get(`/${sid}/plan.html`).status, 404);
});

test("a file root serves only its own name, no sibling", () => {
  const dir = path.join(tmp, "briefs");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "brief.md"), "# Brief\n\ntext\n");
  fs.writeFileSync(path.join(dir, "other.md"), "# Other\n");
  const fid = registerRoot(stateDir, path.join(dir, "brief.md"), "file");
  assert.ok(fid);
  assert.equal(get(`/${fid}/brief.md`).status, 200);
  assert.match(text(get(`/${fid}/brief.md`)), /<h1>Brief<\/h1>/);
  assert.equal(get(`/${fid}/other.md`).status, 404);
  assert.equal(get(`/${fid}/sub/brief.md`).status, 404);
  assert.equal(get(`/${fid}/`).status, 404);
});

test("every request is reported as activity, a 404 too", () => {
  const before = touched;
  get("/nothing");
  get(`/${id}/plan.html`, "evil.example");
  assert.equal(touched, before + 2);
});

test("health answers a nonce with a proof of the key, never the key", () => {
  const nonce = "n".repeat(32);
  const body = JSON.parse(text(get(`/_health/${nonce}`)));
  assert.equal(get(`/_health/${nonce}`).status, 200);
  assert.deepEqual({ ...body, proof: undefined }, { pid: 1, version: "1.0.0", port: 1, bind: "127.0.0.1", proof: undefined });
  assert.ok(!JSON.stringify(body).includes("k".repeat(32)));
  assert.equal(get("/_health/short").status, 404);
  assert.equal(get("/_health/").status, 404);
  assert.equal(get(`/_health/${nonce}/more`).status, 404);
  assert.equal(get(`/_health/${nonce}`, "evil.example").status, 404);
});

test("a root record outside the id shape or a deleted record gives 404", () => {
  const fid = registerRoot(stateDir, pages, "dir");
  assert.ok(fid);
  fs.unlinkSync(path.join(rootsDir(stateDir), `${fid}.json`));
  assert.equal(get(`/${fid}/plan.html`).status, 404);
});

test("servedUrl encodes each segment", () => {
  const rec = { pid: 1, port: 47317, configPort: 47317, bind: "127.0.0.1", version: "1", startedAt: 0, healthKey: "k" };
  assert.equal(servedUrl(rec, { baseUrl: "" }, "ID", "note 1.html"), "http://127.0.0.1:47317/ID/note%201.html");
  assert.equal(servedUrl(rec, { baseUrl: "https://box.example/p/" }, "ID", "plan.html"), "https://box.example/p/ID/plan.html");
});
