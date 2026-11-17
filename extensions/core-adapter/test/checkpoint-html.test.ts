import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { copyStale, currentPlanHash, isPlanPath, readPlan, sha256 } from "../checkpoint.ts";
import { renderHtmlPlanPage } from "../pages.ts";

const PAGE = "<html><body><h1>Widget</h1><section><h2>For the owner</h2><p>Goal: ship.</p></section><h2>Work</h2><p>x</p></body></html>";

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-html-")));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const scratch = path.join(ws, ".workflow/scratch");
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), PAGE);
  return { ws, scratch, opts: { cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch" } };
}

const err = (r: ReturnType<typeof readPlan>): string => ("error" in r ? r.error : "");

test("html plan: hash is sha256 of the whole page, the copy is written with the marker", (t) => {
  const { scratch, opts } = workspace(t);
  const r = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in r, err(r));
  assert.equal(r.plan.kind, "html");
  assert.equal(r.plan.hash, sha256(Buffer.from(PAGE)));
  assert.equal(r.plan.path, path.join(scratch, "plan-widget.html"));
  const copy = fs.readFileSync(path.join(scratch, "plan-widget.md"), "utf8");
  assert.equal(copy, r.plan.markdown);
  assert.match(copy, /^<!-- .*plan-widget\.html/);
  assert.match(copy, /## For the owner/);
  assert.equal(copyStale(r.plan), null);
  assert.equal(currentPlanHash({ topic: "widget", path: r.plan.path, hash: r.plan.hash, status: "approved", approvedAt: null, by: null }, opts), r.plan.hash);
});

test("html plan: any page change, style included, is a new version", (t) => {
  const { scratch, opts } = workspace(t);
  const a = readPlan(".workflow/scratch/plan-widget.html", opts);
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), PAGE.replace("<html>", "<html><head><style>p{color:red}</style></head>"));
  const b = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in a && "plan" in b);
  assert.notEqual(a.plan.hash, b.plan.hash);
});

test("html plan: naming the copy tracks the page", (t) => {
  const { scratch, opts } = workspace(t);
  const page = readPlan(".workflow/scratch/plan-widget.html", opts);
  const copy = readPlan(path.join(scratch, "plan-widget.md"), opts);
  assert.ok("plan" in page && "plan" in copy, err(copy));
  assert.equal(copy.plan.path, page.plan.path);
  assert.equal(copy.plan.hash, page.plan.hash);
  assert.ok(isPlanPath(path.join(scratch, "plan-widget.html"), opts));
});

test("html plan: rulings go below the marker of the copy and do not change the version", (t) => {
  const { scratch, opts } = workspace(t);
  const a = readPlan(".workflow/scratch/plan-widget.html", opts);
  fs.writeFileSync(path.join(scratch, "rulings-widget.md"), "# Ruling\nUse the small one.\n");
  const b = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in a && "plan" in b);
  assert.equal(a.plan.hash, b.plan.hash);
  assert.match(b.plan.markdown, /<!-- plan-appendix -->[\s\S]*Use the small one/);
  assert.match(fs.readFileSync(path.join(scratch, "plan-widget.md"), "utf8"), /Use the small one/);
});

test("html plan: a hand-written plan-<topic>.md without the marker is refused", (t) => {
  const { scratch, opts } = workspace(t);
  fs.writeFileSync(path.join(scratch, "plan-widget.md"), "# mine\n");
  assert.match(err(readPlan(".workflow/scratch/plan-widget.html", opts)), /plan-widget\.md/);
  assert.equal(fs.readFileSync(path.join(scratch, "plan-widget.md"), "utf8"), "# mine\n");
});

test("html plan: a copy over 256 KiB is refused", (t) => {
  const { scratch, opts } = workspace(t);
  fs.writeFileSync(path.join(scratch, "rulings-widget.md"), "x".repeat(300 * 1024));
  assert.match(err(readPlan(".workflow/scratch/plan-widget.html", opts)), /256|large|limit/i);
});

test("html plan: a stale copy is named by copyStale", (t) => {
  const { scratch, opts } = workspace(t);
  const r = readPlan(".workflow/scratch/plan-widget.html", opts);
  assert.ok("plan" in r);
  fs.writeFileSync(path.join(scratch, "plan-widget.md"), "<!-- changed -->\n");
  assert.ok(copyStale(r.plan));
});

test("html plan page: banner after body open, rulings before body close, text escaped", () => {
  const out = renderHtmlPlanPage({ title: "W", kicker: "Plan v1 <x>", html: PAGE, rulings: "<script>alert(1)</script>\n", source: "plan-widget.html" });
  assert.ok(out.indexOf("pi-foreman-banner") > out.indexOf("<body>"));
  assert.ok(out.indexOf("pi-foreman-rulings") < out.indexOf("</body>"));
  assert.ok(!out.includes("<script>alert(1)</script>"));
  assert.ok(out.includes("Plan v1 &lt;x&gt;"));
});
