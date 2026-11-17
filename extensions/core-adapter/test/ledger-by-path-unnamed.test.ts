// D31: a review result whose entry names no ledger marks the bound ledger (B, written last), never another entry's ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

const A_TEXT = "# A\n\n- [ ] 1. alpha item one\n- [ ] 2. alpha item two\n- [ ] V. verify\n";
const B_TEXT = "# B\n\n- [ ] 1. beta item one\n- [ ] 2. beta item two\n- [ ] V. verify\n";

async function world(t: Parameters<typeof r11Rig>[0]) {
  const a = await r11Rig(t, { default: "standard" }, reviewAllowOpts());
  const fa = path.join(a.project, ".workflow", "LEDGER-a.md");
  const fb = path.join(a.project, ".workflow", "LEDGER-b.md");
  await a.toolDoing("write", { path: fa }, () => fs.writeFileSync(fa, A_TEXT));
  await a.toolDoing("write", { path: fb }, () => fs.writeFileSync(fb, B_TEXT));
  return { a, fa, fb };
}

const settle = (ms = 1000): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (f: string): string => fs.readFileSync(f, "utf8");
const done = (text: string, n: number): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(text);
const noticeOf = (runId: string, n: number): string => `Background task completed: **reviewer**\n\nOverall verdict: PASS\n${n}. PASS covered\n\nRetention-managed async directory: /tmp/x/${runId}\n`;

test("a reload with no launch record: an unnamed reviewer run marks the bound ledger", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const r = { agent: "reviewer", task: "review item 1" };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, r, "run-u1");
  await a.restart();
  // the run map is gone, so the notice (no result index, no task text) is what reaches the marks
  await a.notice(noticeOf("run-u1", 1));
  await settle();
  assert.ok(done(read(fb), 1), read(fb));
  assert.ok(!done(read(fa), 1), read(fa));
});

test("a notice of an entry that names no ledger marks the bound ledger", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const r = { agent: "reviewer", task: "review item 1" };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, r, "run-n1");
  await a.notice(noticeOf("run-n1", 1));
  await settle();
  assert.ok(done(read(fb), 1), read(fb));
  assert.ok(!done(read(fa), 1), read(fa));
});

test("a notice of an entry that names A marks A, not the bound ledger", { skip }, async (t) => {
  const { a, fa, fb } = await world(t);
  const r = { agent: "reviewer", task: `review item 1 of ${fa}` };
  const l = await a.launch(r);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, r, "run-n2");
  await a.notice(noticeOf("run-n2", 1));
  await settle();
  assert.ok(done(read(fa), 1), read(fa));
  assert.ok(!done(read(fb), 1), read(fb));
});
