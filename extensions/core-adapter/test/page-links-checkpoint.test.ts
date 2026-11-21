// Served page links in the checkpoint (index.ts, show.ts, ownerdialog.ts): the notify line, the dialog link and the replaced sentence with a served URL; today's exact text without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { planPageLineOf, planPageLineServed } from "../show.ts";
import { ownerDialog } from "../ownerdialog.ts";
import { pageLinks } from "../pagelinks.ts";
import { world } from "./_r46world.ts";

const PLAN = "# Widget plan\n\n## For the owner\nWe ship the widget.\n\n## Goal\nShip it.\n";
const URL_ = "http://127.0.0.1:47317/AbCdEf/plan.html";

/** Runs a checkpoint with `pageLinks.url` replaced by `fake`; the dialog title and the notify notes come back. */
async function run(t: Parameters<typeof world>[0], fake: typeof pageLinks.url) {
  const w = world(t);
  fs.writeFileSync(w.planFile, PLAN);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  const was = pageLinks.url;
  pageLinks.url = fake;
  t.after(() => void (pageLinks.url = was));
  const seen: string[] = [];
  (a.ctx as unknown as { mode: string; ui: { select: unknown } }).mode = "rpc";
  (a.ctx as unknown as { ui: { select: unknown } }).ui.select = async (title: unknown) => (seen.push(String(title)), "approve");
  await a.checkpoint();
  return { w, seen };
}

test("served URL: notify line, dialog link and the replaced sentence", async (t) => {
  const calls: { path: string; kind: string }[] = [];
  const { w, seen } = await run(t, async (p, kind) => (calls.push({ path: p, kind }), URL_));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "dir");
  assert.match(calls[0].path, /pages[\\/]plan\.html$/);
  assert.ok(w.notes.some((n) => n.includes(`Plan page: ${URL_} (served by this machine's page server)`)));
  assert.ok(!w.notes.some((n) => /a path on this session's machine/.test(n)));
  assert.match(seen[0], new RegExp(`Plan page:\\n +${URL_.replace(/[.]/g, "\\.")}`));
  assert.match(seen[0], /The page is served by this machine's page server\./);
  assert.doesNotMatch(seen[0], /The page is a path on this session's machine\./);
});

test("no served URL: the notify line and the dialog text are today's, byte for byte", async (t) => {
  const { w, seen } = await run(t, async () => null);
  const note = w.notes.find((n) => n.includes("Plan page:"))!;
  const m = /Plan page: (file:\/\/\S*plan\.html) \(a path on this session's machine\)/.exec(note);
  assert.ok(m, note);
  assert.equal(note.split("\n").find((l) => l.startsWith("Plan page:")), `Plan page: ${m[1]} (a path on this session's machine)`);
  assert.match(seen[0], /Plan page:\n +file:\/\/.*plan\.html/);
  assert.match(seen[0], /The page is a path on this session's machine\./);
  assert.doesNotMatch(seen[0], /page server/);
});

test("planPageLineServed names the URL; a page that is not available keeps today's line", () => {
  assert.equal(planPageLineServed({ path: "/s/pages/plan.html" } as never, URL_), `Plan page: ${URL_} (served by this machine's page server)`);
  const bad = { reason: "scratch dir off" } as never;
  assert.equal(planPageLineServed(bad, URL_), planPageLineOf(bad));
  assert.equal(planPageLineOf({ path: "/s/pages/plan.html" } as never), `Plan page: ${pathToFileURL("/s/pages/plan.html").href} (a path on this session's machine)`);
});

test("DialogLink.url: the link opens the served URL; the dim line stays the file link; a link without url is unchanged", () => {
  const link = { label: "Plan page", path: "/tmp/pages/plan.html", text: "open the plan page", kind: "page" as const };
  const theme = { fg: (_t: string, s: string) => s, underline: (s: string) => s };
  const styled = ownerDialog({ ask: "Q?", links: [{ ...link, url: URL_ }] }, { theme, links: true }, false).body;
  assert.ok(styled.includes(`\x1b]8;;${URL_}\x1b\\`), styled);
  assert.match(styled, /file:\/\/\/tmp\/pages\/plan\.html/);
  const plain = ownerDialog({ ask: "Q?", links: [{ ...link, url: URL_ }] }, null, false).body;
  assert.ok(plain.includes(URL_));
  const today = ownerDialog({ ask: "Q?", links: [link] }, null, false).body;
  assert.ok(today.includes("file:///tmp/pages/plan.html") && !today.includes("http"));
});
