// HTML plans, gaps found in review: page and copy are one plan in restoreFromStore, a rulings file is no plan for foreman_checkpoint, a rulings write
// leaves the snapshots, the loaded instructions carry the skeleton path, and a wide-and-tall table converts in linear size.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { world } from "./_r46world.ts";
import { readPlan, restoreFromStore, saveStored } from "../checkpoint.ts";
import { htmlToMarkdown } from "../htmlmd.ts";
import { Show } from "../show.ts";

const PAGE = "<html><body><h1>Widget</h1><section><h2>For the owner</h2><p>Goal: ship the widget.</p></section><h2>Work</h2><p>x</p></body></html>";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("restoreFromStore: a page and its generated copy are one plan", (t) => {
  const tmp = fs.realpathSync(mkTestTmp("pf-html-gap-"));
  t.after(() => rmTestTmp(tmp));
  const project = path.join(tmp, "project");
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(path.join(project, ".workflow", "scratch"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, ".workflow/scratch/plan-x.html"), PAGE);
  const opts = { cwd: project, home: os.homedir(), platform: process.platform, scratchDir: ".workflow/scratch" };
  const r = readPlan(".workflow/scratch/plan-x.html", opts);
  assert.ok("plan" in r);
  assert.ok(fs.existsSync(path.join(project, ".workflow/scratch/plan-x.md")), "the generated copy sits beside the page");
  saveStored(agent, r.plan.hash, "ck", { review: { verdict: "pass", model: null, rounds: 1 }, approval: { at: "2026-01-01T00:00:00Z", by: "user" } });
  const back = restoreFromStore(agent, opts);
  assert.equal(back.reviews.length, 1);
  assert.equal(back.reviews[0].plan.kind, "html");
  assert.equal(back.approved?.plan.kind, "html");
  const viaCopy = readPlan(".workflow/scratch/plan-x.md", opts);
  assert.ok("plan" in viaCopy);
  assert.equal(viaCopy.plan.kind, "html", "the copy's name reads as the page");
});

test("foreman_checkpoint does not accept rulings-x.md as a plan", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const scratch = path.dirname(w.planFile);
  fs.writeFileSync(path.join(scratch, "plan-x.html"), PAGE);
  fs.writeFileSync(path.join(scratch, "rulings-x.md"), "Use the small one.\n");
  const tool = a.tool("foreman_checkpoint")!;
  const res = (await tool.execute("ck", { path: ".workflow/scratch/rulings-x.md" }, undefined, undefined, a.ctx)) as { details: { decision: string } };
  assert.equal(res.details.decision, "refused");
});

test("html plan: a rulings write leaves plan.json and the snapshots as they were", async (t) => {
  const tmp = fs.realpathSync(mkTestTmp("pf-html-snap-"));
  t.after(() => rmTestTmp(tmp));
  const ws = path.join(tmp, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  for (const d of [path.join(ws, ".git"), scratch, path.join(tmp, "agent"), path.join(tmp, "handoff")]) fs.mkdirSync(d, { recursive: true });
  const page = path.join(scratch, "plan-widget.html");
  fs.writeFileSync(page, PAGE);
  const show = Show.start({ agentDir: path.join(tmp, "agent"), sessionId: "s1", cwd: ws, home: tmp, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: path.join(tmp, "handoff"), trace: () => undefined } as never)!;
  show.planWritten(page);
  await show.idle();
  fs.writeFileSync(page, PAGE.replace("<p>x</p>", "<p>y</p>"));
  show.planWritten(page);
  await show.idle();
  const state = (): Record<string, string> => Object.fromEntries(fs.readdirSync(show.dir).filter((n) => n.startsWith("plan.")).sort().map((n) => [n, fs.readFileSync(path.join(show.dir, n), "utf8")]));
  const before = state();
  fs.writeFileSync(path.join(scratch, "rulings-widget.md"), "Use the small one.\n");
  show.rulingsWritten(page);
  await show.idle();
  assert.deepEqual(state(), before);
});

test("instructions: the skeleton placeholder becomes the absolute skeleton path, byte-identical on every load", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const load = async (): Promise<string> => {
    const event = { prompt: "go", systemPrompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
    await a.fire("before_agent_start", event);
    return event.systemPromptOptions.sections["pi-foreman"] ?? "";
  };
  const one = await load();
  const two = await load();
  const skeleton = path.join(root, "instructions", "plan-skeleton.html");
  assert.ok(one.includes(skeleton), "the absolute skeleton path is in the text");
  assert.ok(!one.includes("{{planSkeleton}}"));
  assert.equal(one, two);
});

test("htmlmd: a wide-and-tall table converts fast and the output stays linear in the input", () => {
  const html = `<table><tr>${"<td>a</td>".repeat(6000)}</tr>${"<tr><td>x</td></tr>".repeat(6000)}</table>`;
  const start = Date.now();
  const out = htmlToMarkdown(html).markdown;
  assert.ok(Date.now() - start < 2000, "no quadratic work");
  assert.ok(out.length < html.length * 2, `output ${out.length} bytes for ${html.length} of input`);
  assert.equal(htmlToMarkdown(html).markdown, out, "deterministic");
});
