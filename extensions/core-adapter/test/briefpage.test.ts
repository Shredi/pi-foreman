// briefpage.ts: a brief page becomes a text copy (marker + converted text) and a rendered owner page; the error codes; the diagram paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { convertBriefPage } from "../briefpage.ts";
import type { BriefPage } from "../briefpage.ts";
import { PLAN_MAX_BYTES } from "../checkpoint.ts";
import { createEngine } from "../mermaid.ts";
import type { Engine } from "../mermaid.ts";
import { trackedTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(trackedTmp("pf-briefpage-"));
const GOOD = '<svg width="10" height="10"><rect fill="var(--bg)"/><text>a</text></svg>';
const MERMAID = `<h1>Diagram brief</h1>\n<pre class="mermaid">\nflowchart LR\n  A[Start] --> B[Done]\n</pre>\n`;

const put = (name: string, html: string): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, html);
  return file;
};
const ok = (r: Awaited<ReturnType<typeof convertBriefPage>>): BriefPage => {
  assert.ok(!("error" in r), "error" in r ? r.message : "");
  return r;
};
const engineOf = (render: () => Promise<string>): Engine => createEngine({ useWorker: false, timeoutMs: 40, load: async () => ({ renderMermaid: render }) });

test("copy: the marker line, then the converted page; the title is the first heading", async () => {
  const r = ok(await convertBriefPage(put("a.html", "<html><body><h1>Fix the thing</h1><p>Do it <b>now</b>.</p></body></html>")));
  assert.equal(r.markdown, "<!-- generated from the brief page a.html; the page is the source -->\n# Fix the thing\n\nDo it **now**.\n");
  assert.equal(r.title, "Fix the thing");
  assert.equal(r.hiddenTotal, 0);
});

test("page: the plan layout (goal, numbered steps, boxes) and the harness banner", async () => {
  const skeleton = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "instructions", "brief-skeleton.html");
  const r = ok(await convertBriefPage(skeleton, { engine: engineOf(async () => GOOD) }));
  assert.match(r.page, /<p class="goal">/);
  assert.match(r.page, /<ol class="path">/);
  assert.match(r.page, /data-alert="warning"/);
  assert.match(r.page, /id="pi-foreman-banner"[^>]*>Session brief</);
  assert.doesNotMatch(r.page, /pi-foreman-rulings/);
});

test("a page over 256 KiB is refused with brief_too_large", async () => {
  const r = await convertBriefPage(put("big.html", `<p>${"x".repeat(PLAN_MAX_BYTES)}</p>`));
  assert.ok("error" in r);
  assert.equal(r.error, "brief_too_large");
});

test("a page within the limit whose copy (marker and text) is over it is refused with brief_too_large", async () => {
  const text = "x".repeat(PLAN_MAX_BYTES - "<p></p>".length);
  const file = put("edge.html", `<p>${text}</p>`);
  assert.equal(fs.statSync(file).size, PLAN_MAX_BYTES);
  const r = await convertBriefPage(file);
  assert.ok("error" in r);
  assert.equal(r.error, "brief_too_large");
  assert.match(r.message, /text copy/);
});

test("a missing file and a folder are brief_unreadable", async () => {
  for (const p of [path.join(root, "nope.html"), root]) {
    const r = await convertBriefPage(p);
    assert.ok("error" in r);
    assert.equal(r.error, "brief_unreadable");
  }
});

test("hidden-style spots are summed over the kinds", async () => {
  const r = ok(await convertBriefPage(put("h.html", '<p style="display:none">a</p><p style="display: none">b</p><p style="opacity:0">c</p><p hidden>d</p>')));
  assert.equal(r.hiddenTotal, 4);
});

test("diagram: with an engine the page holds the picture, not the source", async () => {
  const r = ok(await convertBriefPage(put("d.html", MERMAID), { engine: engineOf(async () => GOOD) }));
  assert.match(r.page, /<picture>/);
  assert.doesNotMatch(r.page, /<pre class="mermaid">/);
  assert.match(r.markdown, /```mermaid\nflowchart LR/);
});

test("diagram: a missing engine leaves the source on the page", async () => {
  const engine = createEngine({ useWorker: false, load: async () => null });
  const r = ok(await convertBriefPage(put("m.html", MERMAID), { engine }));
  assert.doesNotMatch(r.page, /<picture>/);
  assert.match(r.page, /<pre class="mermaid">/);
});

test("diagram: a render past the per-diagram timeout leaves the source and the call returns", async () => {
  const t0 = Date.now();
  const r = ok(await convertBriefPage(put("t.html", MERMAID), { engine: engineOf(() => new Promise<string>(() => undefined)) }));
  assert.doesNotMatch(r.page, /<picture>/);
  assert.match(r.page, /<pre class="mermaid">/);
  assert.ok(Date.now() - t0 < 5000);
});

test("diagram: the total cap ends a batch whose engine never answers", async () => {
  const hang: Engine = { render: () => new Promise<string>(() => undefined), close: () => undefined };
  const t0 = Date.now();
  const r = ok(await convertBriefPage(put("c.html", MERMAID), { engine: hang, totalMs: 60 }));
  assert.match(r.page, /<pre class="mermaid">/);
  assert.ok(Date.now() - t0 < 5000);
});
