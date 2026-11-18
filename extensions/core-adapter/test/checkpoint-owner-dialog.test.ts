// The plan checkpoint dialog in the owner-dialog shape (index.ts, ownerdialog.ts): the question, the facts (plan, version, review),
// the plan page link (TUI with link support) or its path (rpc), the unchanged choices and the plain blocked label.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_CHOICES } from "../checkpoint.ts";
import { tick, world } from "./_r46world.ts";

const PLAN = "# Widget plan\n\n## For the owner\nWe ship the widget.\n\n## Goal\nShip it.\n";

type Ui = { select: (...a: unknown[]) => Promise<unknown>; custom?: unknown; theme?: unknown };

/** Plain rig (rpc): the select title and options the dialog used. */
async function plain(t: Parameters<typeof world>[0], o: { review?: "PASS" | "FAIL" | null; ceremony?: Record<string, unknown>; mode?: string } = {}) {
  const w = world(t, { ceremony: o.ceremony });
  fs.writeFileSync(w.planFile, PLAN);
  const a = await w.adapter("startup");
  if (o.review) assert.equal(await a.review(o.review), null);
  const seen: { title: string; options: string[] }[] = [];
  const ctx = a.ctx as unknown as { ui: Ui; mode: string };
  ctx.mode = o.mode ?? "rpc";
  ctx.ui.select = async (title: unknown, options: unknown) => (seen.push({ title: String(title), options: options as string[] }), "approve");
  const r = await a.checkpoint();
  await tick();
  return { w, a, seen, r, ctx };
}

test("checkpoint dialog: the question starts with 'Approve the plan for', facts show plan, version and review", async (t) => {
  const { seen, r, w } = await plain(t, { review: "PASS" });
  assert.equal(r.decision, "approve");
  assert.equal(seen.length, 1);
  const [first, , ...rest] = seen[0].title.split("\n");
  assert.equal(first, "Approve the plan for widget?");
  const body = rest.join("\n");
  assert.match(body, /Builders start only after you approve\. Read the plan page first\./);
  assert.match(body, /Plan: +Widget plan/);
  assert.match(body, new RegExp(`Version: +${w.hash().slice(0, 8)}`));
  assert.match(body, /Review: +passed/);
  assert.match(body, /revise: you say what to change +reject: the work stops +approve: builders start\s*$/);
  assert.doesNotMatch(seen[0].title, /\x1b/);
});

test("checkpoint dialog: the choices, their order and the answer handling are unchanged", async (t) => {
  const { seen, r } = await plain(t, { review: "PASS" });
  assert.deepEqual(seen[0].options, [...CHECKPOINT_CHOICES]);
  assert.deepEqual(seen[0].options, ["revise", "reject", "approve"]);
  assert.equal(r.decision, "approve");
});

test("checkpoint dialog: the plan page path is in the dialog (rpc: plain text, no link)", async (t) => {
  const { seen, w } = await plain(t, { review: "PASS" });
  assert.match(seen[0].title, /Plan page:\n +file:\/\/.*plan\.html/);
  assert.doesNotMatch(seen[0].title, /\x1b/);
  assert.ok(w.notes.some((n) => /Plan page: file:\/\/.*plan\.html \(a path on this session's machine\)/.test(n)), "the notice keeps its plan page line");
});

test("checkpoint dialog: a failed review shows 'failed'; a tier without plan review shows 'not required'", async (t) => {
  const failed = await plain(t, { review: "FAIL", ceremony: { planReviewRounds: 1 } });
  assert.match(failed.seen[0].title, /Review: +failed/);
  const none = await plain(t, { ceremony: { default: "standard" } });
  assert.match(none.seen[0].title, /Review: +not required/);
});

test("checkpoint dialog: in the TUI the dialog is Pi's selector through custom; the blocked label is the plain question", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, PLAN);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  const ctx = a.ctx as unknown as { ui: Ui; mode: string };
  const theme = { fg: (_t: string, s: string) => s, underline: (s: string) => s };
  const customs: { options: { blocked: { kind: string; message: string } } }[] = [];
  let selects = 0;
  ctx.ui.theme = theme;
  ctx.ui.select = async () => (selects++, undefined);
  // the capability probe is Pi's own: this test only asserts the wiring, so the factory is not run
  const drawn: string[] = [];
  ctx.ui.custom = async (factory: (...a: unknown[]) => { render(w: number): string[] }, options: { blocked: { kind: string; message: string } }) => {
    customs.push({ options });
    drawn.push(...factory({ requestRender: () => undefined }, theme, {}, () => undefined).render(1000));
    return "approve";
  };
  initTheme("dark");
  const r = await a.checkpoint();
  assert.equal(r.decision, "approve");
  assert.equal(selects, 0, "no plain select in the TUI");
  assert.equal(customs.length, 1);
  const text = drawn.join("\n");
  assert.match(text, /Approve the plan for widget\?/);
  assert.match(text, /Plan page:/);
  assert.match(text, /file:\/\/.*plan\.html/);
  assert.deepEqual(customs[0].options.blocked, { kind: "question", message: "Approve the plan for widget?" });
});

test("checkpoint dialog: the Plan fact drops the heading's own 'Plan:' (case-insensitive), so it reads 'dialog test'", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, "# Plan: dialog test\n\n## For the owner\nWe test the dialog.\n\n## Goal\nShip it.\n");
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  const seen: string[] = [];
  const ctx = a.ctx as unknown as { ui: Ui; mode: string };
  ctx.mode = "rpc";
  ctx.ui.select = async (title: unknown) => (seen.push(String(title)), "approve");
  assert.equal((await a.checkpoint()).decision, "approve");
  await tick();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Plan: +dialog test\n/);
  assert.doesNotMatch(seen[0], /Plan: +Plan:/);
});
