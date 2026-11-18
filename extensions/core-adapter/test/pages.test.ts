// Standalone pages (pages.ts, show.ts): the converter, the picture/fallback/cap rules, the plan, note and result pages, the index, the milestones,
// the checkpoint dialog line, the owner diagram and the foreman_show html parameter.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { planVersionHash } from "../checkpoint.ts";
import { PROSE_FIELDS } from "../gate.ts";
import { fenceSha } from "../mermaid.ts";
import type { Engine } from "../mermaid.ts";
import { fileOfId, NOTES_KEPT, PAGE_MAX_BYTES, foldPlanSection, parsePagesJson, renderMarkdown, renderPage } from "../pages.ts";
import type { PagesIndex } from "../pages.ts";
import { ownerSectionIssues, ownerSummary, planFormIssues } from "../ownertext.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { planPageLine, Show } from "../show.ts";
import type { ShowInit, ShowIo } from "../show.ts";
import { r11Rig } from "./_r11rig.ts";

const A = "# Plan A\n\n## For the owner\nShip it.\n\n## Goal\nShip it.\n";
const B = `${A}\nMore.\n`;
const MM = "graph TD\nA-->B";
const FENCED = `# Doc\n\n\`\`\`mermaid\n${MM}\n\`\`\`\n`;
const SVG = '<svg width="10" height="10"><rect fill="#123456"/></svg>';
const stubEngine = (): Engine => ({ render: async () => SVG, close: () => undefined });

function env(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync.native(mkTestTmp("pf-pages-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  const handoff = path.join(root, "handoffs", "20260101-120000-job");
  for (const d of [path.join(ws, ".git"), scratch, handoff, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  const plan = (topic = "widget") => path.join(scratch, `plan-${topic}.md`);
  const start = (over: Partial<ShowInit> = {}, id = "sess-1") => {
    const traces: Record<string, unknown>[] = [];
    const show = Show.start({ agentDir: path.join(root, "agent"), sessionId: id, cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: null, trace: (r) => void traces.push(r), ...over });
    return { show: show!, traces };
  };
  return { root, ws, scratch, handoff, plan, start };
}

const pagesDir = (show: Show) => path.join(show.dir, "pages");
const page = (show: Show, file: string) => fs.readFileSync(path.join(pagesDir(show), file), "utf8");
const index = (show: Show) => JSON.parse(fs.readFileSync(path.join(pagesDir(show), "pages.json"), "utf8")) as PagesIndex;
const listed = (show: Show) => fs.readdirSync(pagesDir(show)).sort();

// ---------------------------------------------------------------- converter

test("markdown: headings, paragraphs, emphasis, code, lists, tables, quotes and rules", () => {
  const html = renderMarkdown("# Title\n\nA **bold** and *soft* and `code` and ~~gone~~ line\nsecond line.\n\n---\n\n> quoted\n\n- one\n  - nested\n- two\n\n1. a\n2. b\n\n| h1 | h2 |\n|:--|--:|\n| x | y |\n\n```ts\nlet a = 1 < 2;\n```\n");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>A <strong>bold<\/strong> and <em>soft<\/em> and <code>code<\/code> and <del>gone<\/del> line second line\.<\/p>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<ul>\n<li>one\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>a<\/li>\n<li>b<\/li>\n<\/ol>/);
  assert.match(html, /<th style="text-align:left">h1<\/th><th style="text-align:right">h2<\/th>/);
  assert.match(html, /<td style="text-align:left">x<\/td><td style="text-align:right">y<\/td>/);
  assert.match(html, /<pre><code class="language-ts">let a = 1 &lt; 2;<\/code><\/pre>/);
});

test("markdown: raw HTML is escaped everywhere, also in code, cells and link text", () => {
  const html = renderMarkdown("<script>alert(1)</script>\n\n# <img src=x onerror=1>\n\n| <b>c</b> |\n|--|\n| <i>d</i> |\n\n[<u>t</u>](https://a.test/?q=1&r=2)\n\n`<b>`\n\n```\n</pre><script>x</script>\n```\n");
  assert.doesNotMatch(html, /<script|<img|<b>|<i>|<u>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<a href="https:\/\/a\.test\/\?q=1&amp;r=2">&lt;u&gt;t&lt;\/u&gt;<\/a>/);
});

test("markdown: links keep only http, https and relative targets", () => {
  const html = renderMarkdown("[a](https://x.test) [b](http://x.test/p) [c](docs/a.md#x) [d](javascript:alert) [e](data:text/html,x) [f](//evil.test/x) [g](file:///etc/passwd) [h](JaVaScRiPt:x)");
  assert.match(html, /<a href="https:\/\/x\.test">a<\/a>/);
  assert.match(html, /<a href="http:\/\/x\.test\/p">b<\/a>/);
  assert.match(html, /<a href="docs\/a\.md#x">c<\/a>/);
  assert.equal((html.match(/<a /g) ?? []).length, 3);
  assert.doesNotMatch(html, /javascript:|data:|file:|evil/i);
});

test("markdown: an unterminated fence runs to the end, and a placeholder character in the text is harmless", () => {
  assert.match(renderMarkdown("```\nabc"), /<pre><code>abc<\/code><\/pre>/);
  assert.doesNotMatch(renderMarkdown("a \u00000\u0000 b `x`"), /\u0000/);
});

// ---------------------------------------------------------------- picture, fallback, cap

test("page: a mermaid fence with sidecars is a picture of two data URIs, without them a code block", () => {
  const svgs = new Map([[fenceSha(MM), { dark: "<svg>dark</svg>", light: "<svg>light</svg>" }]]);
  const withSvg = renderPage({ title: "T", kicker: "Plan v1", markdown: FENCED, svgs, source: "plan-x.md" });
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  assert.ok(withSvg.includes(`<picture><source media="(prefers-color-scheme: dark)" srcset="data:image/svg+xml;base64,${b64("<svg>dark</svg>")}"><img alt="diagram" src="data:image/svg+xml;base64,${b64("<svg>light</svg>")}"></picture>`));
  assert.doesNotMatch(withSvg, /language-mermaid/);
  const without = renderPage({ title: "T", kicker: "Plan v1", markdown: FENCED, source: "plan-x.md" });
  assert.match(without, /<pre><code class="language-mermaid">graph TD\nA--&gt;B<\/code><\/pre>/);
  assert.match(withSvg, /prefers-color-scheme:dark/); // the stylesheet follows the system setting
});

test("page: over 900 KiB the diagrams become code blocks; still over it, the page names the markdown file", () => {
  const big = "x".repeat(PAGE_MAX_BYTES - 1000);
  const svgs = new Map([[fenceSha(MM), { dark: big, light: big }]]);
  const dropped = renderPage({ title: "T", kicker: "k", markdown: FENCED, svgs, source: "plan-x.md" });
  assert.ok(Buffer.byteLength(dropped) <= PAGE_MAX_BYTES);
  assert.match(dropped, /language-mermaid/);
  assert.doesNotMatch(dropped, /base64/);
  const huge = renderPage({ title: "T", kicker: "k", markdown: `# t\n\n${"word ".repeat(PAGE_MAX_BYTES / 4)}`, source: "plan-x.md" });
  assert.ok(Buffer.byteLength(huge) < 4000);
  assert.match(huge, /too large/);
  assert.match(huge, /<code>plan-x\.md<\/code>/);
  assert.doesNotMatch(huge, /word word/);
});

// ---------------------------------------------------------------- index

test("index: file is derived from the id; bad entries, a planted ../ id and foreign files are dropped on reload", () => {
  assert.equal(fileOfId("plan"), "plan.html");
  assert.equal(fileOfId("result"), "result.html");
  assert.equal(fileOfId("note-7"), "note-7.html");
  for (const bad of ["../x", "note-0", "note-01", "note-1234567", "plan.html", "note-1/../../x", "", 5, null]) assert.equal(fileOfId(bad), null, String(bad));
  const e = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: id.startsWith("note") ? "note" : id, title: "t", state: "s", version: 1, at: "2026-01-01T00:00:00Z", file: fileOfId(id), ...over });
  const idx = parsePagesJson(JSON.stringify({ v: 1, pages: [e("plan"), e("../../etc/x", { file: "../../etc/x" }), e("note-1", { file: "evil.html" }), e("note-2", { kind: "plan" }), e("note-3"), e("note-3"), { id: "result" }], events: [{ at: "a", kind: "k", text: "t", page: "plan" }, { at: "a", kind: "k", text: "t", page: "../x" }, { nope: 1 }] }));
  assert.deepEqual(idx?.pages.map((p) => p.id), ["plan", "note-3"]);
  assert.equal(idx?.events.length, 2);
  assert.equal(idx?.events[1].page, undefined);
  assert.equal(parsePagesJson("{"), null);
  assert.equal(parsePagesJson(JSON.stringify({ v: 2, pages: [], events: [] })), null);
});

// ---------------------------------------------------------------- plan page

test("plan page: each of the four trigger calls writes it, whether or not plan.json changed", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  show.planWritten(e.plan());
  await show.idle();
  assert.match(page(show, "plan.html"), /Plan v1 · draft · [0-9a-f]{8}/);
  assert.match(page(show, "plan.html"), /<h1>Plan A<\/h1>/);
  const entry = index(show).pages.find((p) => p.id === "plan")!;
  assert.deepEqual([entry.kind, entry.state, entry.version, entry.file], ["plan", "draft", 1, "plan.html"]);
  // planReviewLaunched
  const launch = `[plan-review] plan: ${e.plan()}`;
  fs.rmSync(path.join(pagesDir(show), "plan.html"));
  show.planReviewLaunched(launch);
  await show.idle();
  assert.match(page(show, "plan.html"), /in review/);
  // checkpointed on an unchanged plan: sync() writes nothing new, the page is still written
  fs.rmSync(path.join(pagesDir(show), "plan.html"));
  const out = await show.checkpointed(e.plan());
  assert.deepEqual(out, { path: path.join(pagesDir(show), "plan.html") });
  assert.match(page(show, "plan.html"), /waits for you/);
  // checkpointed again on the same, already ruled plan
  fs.rmSync(path.join(pagesDir(show), "plan.html"));
  await show.checkpointed(e.plan());
  assert.match(page(show, "plan.html"), /waits for you/);
  // planSent on an unchanged plan
  fs.rmSync(path.join(pagesDir(show), "plan.html"));
  show.planSent(`Plan from job: ${e.plan()}`);
  await show.idle();
  assert.match(page(show, "plan.html"), /Plan v1 · waits for you/);
  // planWritten on an unchanged plan
  fs.rmSync(path.join(pagesDir(show), "plan.html"));
  show.planWritten(e.plan());
  await show.idle();
  assert.match(page(show, "plan.html"), /Plan v1/);
});

test("plan page: states draft, in review, waits for you, approved, revise, rejected; a changed plan is a draft again", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  const hash = planVersionHash(Buffer.from(A));
  const state = () => index(show).pages.find((p) => p.id === "plan")!.state;
  show.planWritten(e.plan());
  await show.idle();
  assert.equal(state(), "draft");
  show.planReviewLaunched(`[plan-review] ${e.plan()}`);
  await show.idle();
  assert.equal(state(), "in review");
  show.planReviewed(false, hash);
  await show.idle();
  assert.equal(state(), "revise");
  show.planReviewed(true, hash);
  await show.idle();
  assert.equal(state(), "draft");
  await show.checkpointed(e.plan());
  assert.equal(state(), "waits for you");
  show.planDecided("approved", hash);
  await show.idle();
  assert.equal(state(), "approved");
  assert.match(page(show, "plan.html"), /approved/);
  show.planDecided("revise", hash);
  await show.idle();
  assert.equal(state(), "revise");
  show.planDecided("rejected", hash);
  await show.idle();
  assert.equal(state(), "rejected");
  fs.writeFileSync(e.plan(), B);
  show.planWritten(e.plan());
  await show.idle();
  assert.equal(state(), "draft");
  assert.equal(index(show).pages.find((p) => p.id === "plan")!.version, 2);
  // the already-approved early return of foreman_checkpoint writes the approved state
  await show.checkpointed(e.plan(), "approved");
  assert.equal(state(), "approved");
});

test("plan page: rewritten with the picture when its diagrams are listed", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), `${A}\n\`\`\`mermaid\n${MM}\n\`\`\`\n`);
  const { show } = e.start({ engine: () => stubEngine() });
  show.planWritten(e.plan());
  await show.idle();
  assert.match(page(show, "plan.html"), /<picture>/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(show.dir, "plan.json"), "utf8")).diagrams.length, 1);
});

test("plan page: before the diagrams exist the fence is a code block", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), `${A}\n\`\`\`mermaid\n${MM}\n\`\`\`\n`);
  let release!: () => void;
  const gate = new Promise<void>((res) => void (release = res));
  const { show } = e.start({ engine: () => ({ render: async () => (await gate, SVG), close: () => undefined }) });
  show.planWritten(e.plan());
  // the write is queued: poll (about 5 s) for the file instead of a fixed sleep, then assert
  const planPage = path.join(pagesDir(show), "plan.html");
  for (let i = 0; i < 250 && !fs.existsSync(planPage); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(page(show, "plan.html"), /language-mermaid/);
  release();
  await show.idle();
  assert.match(page(show, "plan.html"), /<picture>/);
});

test("plan page: a symlinked pages/ is refused and nothing is written behind it", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(e.plan(), A);
  const { show, traces } = e.start();
  fs.mkdirSync(show.dir, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(show.dir, "pages"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  const again = e.start().show; // a reload reads nothing from behind the link
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(traces.some((r) => r.event === "show_error"));
  assert.deepEqual(await again.checkpointed(e.plan()).then((o) => "reason" in o), true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("checkpointed: the promise carries the page file, or the reason it is not there", async (t) => {
  const e = env(t);
  const { show } = e.start();
  assert.deepEqual(await show.checkpointed(path.join(e.scratch, "plan-gone.md")), { reason: "plan not readable" });
  fs.writeFileSync(e.plan(), A);
  const failing = e.start({ io: { writeFile: async () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } } as Partial<ShowIo> }, "sess-2").show;
  const out = await failing.checkpointed(e.plan());
  assert.ok("reason" in out && /^page failed: EACCES$/.test(out.reason), JSON.stringify(out));
});

test("dialog line: the file URL, or the real reason (scratch dir off, not written yet, failed)", async () => {
  const file = path.join(path.parse(process.cwd()).root, "tmp", "x y", "plan.html");
  assert.equal(await planPageLine(Promise.resolve({ path: file })), `Plan page: ${pathToFileURL(file).href} (a path on this session's machine)`);
  assert.equal(await planPageLine(undefined), "Plan page: not available (scratch dir off)");
  assert.equal(await planPageLine(new Promise(() => undefined), 20), "Plan page: not available (page not written yet)");
  assert.equal(await planPageLine(Promise.resolve({ reason: "page failed: EACCES" })), "Plan page: not available (page failed: EACCES)");
  assert.match(await planPageLine(Promise.resolve({ path: file })), /file:\/\/.*x%20y/);
});

// ---------------------------------------------------------------- notes

test("note page: every note writes a page, the last 20 are kept, an earlier one is deleted by its derived name only", async (t) => {
  const e = env(t);
  const { show } = e.start();
  for (let i = 1; i <= NOTES_KEPT + 2; i++) await show.note(`T${i}`, `# n${i}\n`);
  const files = listed(show).filter((f) => f.startsWith("note-"));
  assert.equal(files.length, NOTES_KEPT);
  assert.ok(!files.includes("note-1.html") && !files.includes("note-2.html") && files.includes("note-3.html") && files.includes("note-22.html"));
  assert.deepEqual(index(show).pages.filter((p) => p.kind === "note").map((p) => p.id).length, NOTES_KEPT);
  assert.match(page(show, "note-22.html"), /<h1>T22<\/h1>/);
});

test("note page: a planted ../ id in pages.json is ignored on reload and never deleted", async (t) => {
  const e = env(t);
  const first = e.start().show;
  await first.note("T", "one");
  const victim = path.join(first.dir, "keep.txt");
  fs.writeFileSync(victim, "keep");
  const file = path.join(pagesDir(first), "pages.json");
  const idx = JSON.parse(fs.readFileSync(file, "utf8")) as PagesIndex;
  for (let i = 0; i < NOTES_KEPT; i++) idx.pages.push({ id: "../keep.txt", kind: "note", title: "x", state: "s", version: 0, at: "a", file: "../keep.txt" });
  fs.writeFileSync(file, JSON.stringify(idx));
  const again = e.start().show;
  for (let i = 0; i < NOTES_KEPT + 1; i++) await again.note("T", `n${i}`);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
});

test("note page: a page that is a symlink is not followed by the delete", async (t) => {
  const e = env(t);
  const { show } = e.start();
  await show.note("T1", "one");
  const outside = path.join(e.root, "outside.txt");
  fs.writeFileSync(outside, "keep");
  fs.rmSync(path.join(pagesDir(show), "note-1.html"));
  try {
    fs.symlinkSync(outside, path.join(pagesDir(show), "note-1.html"));
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  for (let i = 2; i <= NOTES_KEPT + 1; i++) await show.note(`T${i}`, "x");
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.ok(fs.lstatSync(path.join(pagesDir(show), "note-1.html")).isSymbolicLink(), "the link itself stays; only a regular file is removed");
});

test("note page: a markdown note's page is rewritten with its diagrams", async (t) => {
  const e = env(t);
  const { show } = e.start({ engine: () => stubEngine() });
  await show.note("T", FENCED);
  await show.idle();
  assert.match(page(show, "note-1.html"), /<picture>/);
});

test("note page: an html note is stored as is and note.md names the page", async (t) => {
  const e = env(t);
  const { show } = e.start();
  const html = '<!doctype html><html><body><script>fetch("https://x.test")</script><video src="https://x.test/v.mp4"></video></body></html>';
  const r = await show.note("Raw", "", html);
  assert.equal(page(show, "note-1.html"), html);
  assert.equal(r.page, path.join(pagesDir(show), "note-1.html"));
  assert.match(fs.readFileSync(path.join(show.dir, "note.md"), "utf8"), /note-1\.html/);
  await assert.rejects(show.note("Big", "", "x".repeat(256 * 1024 + 1)));
  assert.equal((await show.note("Edge", "", "x".repeat(256 * 1024))).v, 2);
});

test("foreman_show: html parameter, exactly one of markdown or html, the 256 KiB cap, and html is a prose field", async (t) => {
  const tools = new Map<string, { description: string; parameters: { properties: Record<string, unknown>; required: string[] }; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  const rig = await r11Rig(t, {}, { piExtra: { registerTool: (d: { name: string }) => void tools.set(d.name, d as never) } });
  const d = tools.get("foreman_show")!;
  const call = (params: Record<string, unknown>) => d.execute("id", params, undefined, undefined, rig.ctx);
  assert.match(d.description, /writes a standalone page/);
  assert.ok("html" in d.parameters.properties);
  assert.deepEqual(d.parameters.required, ["title"]);
  const ok = await call({ title: "Raw", html: "<p>hi</p>" });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.match(ok.content[0].text, /^shown: Raw \(v1, 0 diagrams\) at .*note\.md\. It writes a page the owner opens in the browser: .*note-1\.html\./);
  assert.doesNotMatch(ok.content[0].text, /pi-foreman hint/); // the reply carries no hint
  for (const params of [{ title: "T" }, { title: "T", markdown: "a", html: "<p>b</p>" }]) {
    const r = await call(params);
    assert.ok(r.isError);
    assert.match(r.content[0].text, /exactly one of markdown or html/);
  }
  const big = await call({ title: "T", html: "x".repeat(256 * 1024 + 1) });
  assert.ok(big.isError);
  assert.match(big.content[0].text, /262144/);
  assert.ok(PROSE_FIELDS.has("html"));
  const md = await call({ title: "Md", markdown: "# hi\n" });
  assert.match(md.content[0].text, /It writes a page the owner opens in the browser: .*note-2\.html\./);
});

// ---------------------------------------------------------------- result page

test("result page: a write of the handoff result.md is read through the guarded reader; a symlink is refused; no pages elsewhere", async (t) => {
  const e = env(t);
  const rp = path.join(e.handoff, "result.md");
  fs.writeFileSync(rp, "# Done\n\nAll good.\n");
  const { show } = e.start({ handoffDir: e.handoff });
  assert.equal(show.resultWritten(path.join(e.ws, "result.md")), false);
  assert.equal(show.resultWritten(rp), true);
  await show.idle();
  assert.match(page(show, "result.html"), /<h1>Done<\/h1>/);
  assert.match(page(show, "result.html"), /All good\./);
  const entry = index(show).pages.find((p) => p.id === "result")!;
  assert.deepEqual([entry.kind, entry.file, entry.version], ["result", "result.html", 1]);
  assert.ok(index(show).events.some((x) => x.kind === "result" && x.page === "result"));
  // a symlinked result.md is refused: nothing is read and the old page stays
  const foreign = path.join(e.root, "foreign.md");
  fs.writeFileSync(foreign, "# not mine\n");
  fs.rmSync(rp);
  fs.symlinkSync(foreign, rp);
  show.resultWritten(rp);
  await show.idle();
  assert.doesNotMatch(page(show, "result.html"), /not mine/);
  // a session without a handoff dir has no result page
  const plain = e.start({}, "sess-2").show;
  assert.equal(plain.resultWritten(rp), false);
});

// ---------------------------------------------------------------- milestones

test("milestones: plan review verdict, checkpoint answer and result are listed, at most 50, each with its page", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  const hash = planVersionHash(Buffer.from(A));
  show.planWritten(e.plan());
  show.planReviewed(true, hash);
  show.planReviewed(false, hash);
  show.planDecided("approved", hash);
  show.planDecided("revise", hash);
  show.planDecided("rejected", hash);
  await show.idle();
  assert.deepEqual(index(show).events.map((x) => [x.kind, x.text, x.page]), [
    ["plan_review", "Plan review: PASS", "plan"],
    ["plan_review", "Plan review: FAIL", "plan"],
    ["checkpoint", "You approved the plan", "plan"],
    ["checkpoint", "You asked for a revision of the plan", "plan"],
    ["checkpoint", "You rejected the plan", "plan"],
  ]);
  for (let i = 0; i < 60; i++) show.milestone("pr_opened", `PR #${i} opened`);
  await show.idle();
  const ev = index(show).events;
  assert.equal(ev.length, 50);
  assert.equal(ev.at(-1)!.text, "PR #59 opened");
  assert.ok(ev.every((x) => typeof x.at === "string"));
});

test("milestones: PR opened, ready and merged come from the PR watch", async () => {
  const seen: string[] = [];
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => fns.push(fn), clear: () => {} };
  let next: WatchSnapshot = { state: "open", mergeable: "mergeable", head: "abc1234567", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }] };
  let at = 1_000_000;
  const storeEntry = async (): Promise<StoreRead> => ({ kind: "entry", snap: next, okAt: (at += 1000) });
  const watches = new PrWatches({ storeEntry, send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers, child: () => true, milestone: (k, n) => void seen.push(`${k}:${n}`) });
  const key = { host: "github.com", repo: "acme/app", n: 7 };
  watches.startPending(key, undefined, undefined, false);
  assert.deepEqual(seen, [], "a watch of a PR this session did not create records no PR opened");
  watches.unwatch(7, "acme/app", "github.com");
  watches.startPending(key, undefined, undefined, false, true);
  assert.deepEqual(seen, ["pr_opened:7"]);
  fns.at(-1)!();
  await new Promise((r) => setImmediate(r));
  fns.at(-1)!();
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.includes("pr_ready:7"), seen.join());
  next = { ...next, state: "merged" };
  fns.at(-1)!();
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.includes("pr_merged:7"), seen.join());
});

// ---------------------------------------------------------------- owner diagram

const OWNER = (extra: string) => `# P\n\n## For the owner\nWe make it faster.\n${extra}\n## Goal\nx\n`;
const FENCE_LINES = "```mermaid\ngraph TD\nA-->B\n```\n";

test("owner diagram: any number of mermaid fences is allowed", () => {
  const manyLines = Array.from({ length: 9 }, (_, i) => `Line ${i} in plain words.`).join("\n");
  assert.deepEqual(ownerSectionIssues(OWNER(`${manyLines}\n${FENCE_LINES}`)), []);
  assert.deepEqual(ownerSectionIssues(OWNER(`${manyLines}\nTen.\nEleven.\n${FENCE_LINES}`)), [], "no length limit");
  const long = `${"graph TD\n"}${Array.from({ length: 200 }, (_, i) => `N${i}-->N${i + 1}`).join("\n")}`;
  assert.deepEqual(ownerSectionIssues(OWNER(`\`\`\`mermaid\n${long}\n\`\`\`\n`)), [], "the diagram's characters do not count");
  assert.deepEqual(ownerSectionIssues(OWNER(`${FENCE_LINES}${FENCE_LINES}`)), []);
  assert.deepEqual(planFormIssues(OWNER(`${FENCE_LINES}${FENCE_LINES}`), {}), []);
  assert.deepEqual(planFormIssues(OWNER(FENCE_LINES), {}), []);
});

test("owner diagram: the dialog summary points at the plan page in its place", () => {
  const s = ownerSummary(OWNER(`${FENCE_LINES}Then we test it.\n`));
  assert.match(s, /We make it faster\.\n {2}\(diagram: see the plan page\)\n {2}Then we test it\./);
  assert.doesNotMatch(s, /graph TD|```/);
});

// ---------------------------------------------------------------- folded sections

const FOLDED = "# P\n\nIntro text.\n\n## For the owner\n- Goal: x.\n\n## Plan\n1. One.\n\n```md\n## Not a heading\n```\n\n## Open questions\n- none.\n";

test("fold: a folded section sits in details with its heading visible; the owner and open questions sections stay open", () => {
  const html = renderMarkdown(FOLDED, { fold: foldPlanSection });
  assert.match(html, /<details><summary>Plan<\/summary>\n<ol>/);
  assert.equal((html.match(/<details>/g) ?? []).length, 1);
  assert.match(html, /<h2>For the owner<\/h2>/);
  assert.match(html, /<h2>Open questions<\/h2>/);
  assert.match(html, /^<h1>P<\/h1>\n<p>Intro text\.<\/p>\n<h2>For the owner/);
  assert.equal(foldPlanSection("  FOR THE OWNER "), false);
  assert.equal(foldPlanSection("open QUESTIONS"), false);
  assert.equal(foldPlanSection("Decisions and assumptions"), true);
});

test("fold: a `## ` line inside a fence does not split a section", () => {
  const html = renderMarkdown(FOLDED, { fold: foldPlanSection });
  assert.match(html, /<details><summary>Plan<\/summary>[\s\S]*## Not a heading[\s\S]*<\/details>/);
  assert.equal((html.match(/<summary>/g) ?? []).length, 1);
  const tilde = renderMarkdown("## A\n~~~\n## B\n~~~\n", { fold: () => true });
  assert.equal((tilde.match(/<summary>/g) ?? []).length, 1);
});

test("fold: without it the output is unchanged, and a folded body equals the unfolded rendering of the section", () => {
  assert.equal(renderMarkdown(FOLDED), renderMarkdown(FOLDED, { fold: () => false }));
  const body = "1. One.\n\n```md\n## Not a heading\n```\n";
  const folded = renderMarkdown(`## Plan\n${body}`, { fold: () => true });
  assert.equal(folded, `<details><summary>Plan</summary>\n${renderMarkdown(body)}\n</details>`);
});

test("fold: a ## heading indented inside a list item does not start a folded section", () => {
  const html = renderMarkdown("## Plan\n- item\n  ## inner\n\n## Goal\nx\n", { fold: () => true });
  assert.equal((html.match(/<details>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<summary>inner<\/summary>/);
});
