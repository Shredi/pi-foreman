// HTML plans, more cases (checkpoint.ts, ownertext.ts, pages.ts): appendix text inside a page, sidecar links, owner facts, the page with diagrams.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { planBody, readPlan, sha256 } from "../checkpoint.ts";
import { ownerFactsLines } from "../ownertext.ts";
import { PAGE_MAX_BYTES, renderHtmlPlanPage } from "../pages.ts";

const PAGE = "<html><body><h1>Widget</h1><section><h2>For the owner</h2><p>Goal: ship.</p></section><h2>Work</h2><p>x</p></body></html>";

function workspace(t: { after: (fn: () => void) => void }, page = PAGE) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-html2-")));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const scratch = path.join(ws, ".workflow/scratch");
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), page);
  return { root, ws, scratch, opts: { cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch" } };
}

const err = (r: ReturnType<typeof readPlan>): string => ("error" in r ? r.error : "");

test("html plan: a literal appendix marker line in the page, and a Ruling heading, do not split the version", (t) => {
  const page = "<html><body><h1>W</h1><section><h2>For the owner</h2><p>Goal.</p></section>\n<!-- plan-appendix -->\n<p>below</p><h2>Ruling</h2><p>r</p>\n  <h2>Ruling</h2><pre>&lt;!-- plan-appendix --&gt;\n## Ruling</pre></body></html>";
  const { scratch, opts } = workspace(t, page);
  const a = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in a, err(a));
  assert.equal(a.plan.hash, sha256(Buffer.from(page)));
  // the copy's own appendix marker is the harness's one: planBody keeps all the converted page text
  const body = planBody(Buffer.from(a.plan.markdown)).toString("utf8");
  assert.match(body, /## For the owner/);
  assert.match(body, /below/);
  assert.match(body, /# W/);
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), page.replace("below", "below too"));
  const b = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in b);
  assert.notEqual(b.plan.hash, a.plan.hash, "an edit below the literal marker line is a new version");
});

test("html plan: a symlinked or hard-linked rulings sidecar is refused naming the rulings file", { skip: process.platform === "win32" }, (t) => {
  const { root, scratch, opts } = workspace(t);
  fs.writeFileSync(path.join(root, "outside.md"), "x\n");
  fs.symlinkSync(path.join(root, "outside.md"), path.join(scratch, "rulings-widget.md"));
  assert.match(err(readPlan(".workflow/scratch/plan-widget.html", opts)), /rulings-widget\.md/);
  fs.rmSync(path.join(scratch, "rulings-widget.md"));
  fs.linkSync(path.join(root, "outside.md"), path.join(scratch, "rulings-widget.md"));
  assert.match(err(readPlan(".workflow/scratch/plan-widget.html", opts)), /rulings-widget\.md/);
});

test("html plan: a copy edit is written again from the page", (t) => {
  const { scratch, opts } = workspace(t);
  const a = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in a);
  const copy = path.join(scratch, "plan-widget.md");
  fs.writeFileSync(copy, `${fs.readFileSync(copy, "utf8")}\nextra\n`);
  const b = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in b);
  assert.equal(fs.readFileSync(copy, "utf8"), a.plan.markdown);
});

test("html plan: the title comes from the page, never the marker line", (t) => {
  const { opts } = workspace(t, "<html><head><title>T</title></head><body><section><h2>For the owner</h2><p>g</p></section></body></html>");
  const r = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in r);
  assert.equal(r.plan.title, "T");
});

test("html plan: ownerFactsLines reads the copy of a page", (t) => {
  const { ws, opts } = workspace(t);
  const lines = ownerFactsLines([".workflow/scratch/plan-widget.html"], ws, opts);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /not readable/);
});

test("html plan page: the model's markup stays, a diagram replaces its mermaid pre, an oversize page drops the SVGs first", async () => {
  const { fenceSha } = await import("../mermaid.ts");
  const diagram = "graph TD\n A-->B";
  const page = `<html><body><h1>W</h1><pre class="mermaid">${diagram}</pre><p>after</p></body></html>`;
  const svgs = new Map([[fenceSha(diagram), { dark: "<svg>d</svg>", light: "<svg>l</svg>" }]]);
  const out = renderHtmlPlanPage({ title: "W", kicker: "k", html: page, rulings: "", svgs, source: "plan-widget.html" });
  assert.match(out, /<picture>/);
  assert.ok(!out.includes("class=\"mermaid\""));
  assert.match(out, /<p>after<\/p>/);
  const big = new Map([[fenceSha(diagram), { dark: "d".repeat(PAGE_MAX_BYTES), light: "l" }]]);
  const text = renderHtmlPlanPage({ title: "W", kicker: "k", html: page, rulings: "", svgs: big, source: "plan-widget.html" });
  assert.ok(!text.includes("<picture>"));
  assert.match(text, /class="mermaid"/);
  const rulings = renderHtmlPlanPage({ title: "W", kicker: "k", html: page, rulings: "y".repeat(PAGE_MAX_BYTES), source: "plan-widget.html" });
  assert.match(rulings, /too large/);
});
