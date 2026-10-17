// R11 items 4/5 (parent ruling: ruling-file lifts dropped): the former forgery probes (a ruling rewritten with its old
// mtime restored, a ruling written through a symlink) have no effect on the review cap or the read budget; the
// finalization command is one allowlist regex that refuses anything it cannot classify.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS, finalizationCommand } from "../budget.ts";
import { r11Rig, writeAt } from "./_r11rig.ts";

const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const capRefused = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[review_cap\]/.test(r.reason ?? "");
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");
const DENY = DEFAULT_READ_LIMITS.before.deny;
const fin = (command: string) => finalizationCommand("bash", { command });

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** A rig with reviewRuns 1, one review used, and a child-side handoff dir with an old ask.md. */
async function capped(t: Parameters<typeof r11Rig>[0]): Promise<{ a: Rig; dir: string }> {
  const a = await r11Rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  writeAt(path.join(dir, "ask.md"), "ask: one more review round?\n", Date.now() - 60_000);
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "capped before any ruling");
  return { a, dir };
}

test("ruling_no_effect_rewrite_mtime_restored", async (t) => {
  const { a, dir } = await capped(t);
  const file = path.join(dir, "ruling.md");
  writeAt(file, "APPROVED\nreview-cap: +0\nread-budget: +0\n", Date.now() - 1000);
  await a.toolDoing("bash", { command: "./tools/fixup.sh" }, () => {
    const st = fs.statSync(file);
    fs.writeFileSync(file, "APPROVED\nreview-cap: +9\nread-budget: +9\n");
    fs.utimesSync(file, st.atime, st.mtime);
  });
  assert.ok(capRefused((await a.launch(review(2))).res), "the rewritten ruling does not lift the cap");
  const out = [];
  for (let i = 0; i < DENY + 1; i++) out.push(await a.call("bash", { command: `ls -la r${i}` }));
  assert.ok(readDenied(out[DENY]), "nor the read budget");
  assert.deepEqual(a.events("review_cap_lift"), []);
  assert.deepEqual(a.events("read_budget").filter((r) => r.action === "lift"), []);
});

test("ruling_no_effect_write_via_symlink", async (t) => {
  const { a, dir } = await capped(t);
  const link = path.join(a.project, ".workflow", "notes.md");
  fs.symlinkSync(path.join(dir, "ruling.md"), link);
  const text = "APPROVED\nreview-cap: +2\nread-budget: +20\n";
  const res = await a.toolDoing("write", { path: link, content: text }, () => fs.writeFileSync(link, text));
  assert.equal(res, undefined, `write: ${res?.reason}`);
  assert.equal(fs.readFileSync(path.join(dir, "ruling.md"), "utf8"), text, "the write landed on the ruling");
  assert.ok(capRefused((await a.launch(review(2))).res), "a ruling written through a symlink does not lift the cap");
  const out = [];
  for (let i = 0; i < DENY + 1; i++) out.push(await a.call("bash", { command: `ls -la s${i}` }));
  assert.ok(readDenied(out[DENY]), "nor the read budget");
  assert.deepEqual(a.events("review_cap_lift"), []);
});

test("finalization_command_ansi_c_quote_refused", () => {
  for (const c of ["git commit -m $'x\\' ; cat secret ; \\''", "git commit -m $'msg'", "git log $'--output=x'", "git status $'\\x26' cat x", "git commit -m \"a\" $'b'"]) assert.equal(fin(c), false, c);
  assert.equal(fin("git commit -m 'msg'"), true, "control: a plain single-quoted message");
});

test("finalization_command_hash_or_backslash_refused", () => {
  for (const c of [
    "git status # ; cat x",
    "git status #",
    "git commit -m x \\; cat y",
    "git commit -m x\\\ncat y",
    'git commit -m "a\\"b"',
    'git commit -m "$HOME"',
    'git commit -m "`id`"',
    "git log ~/x",
    "git status (x)",
    "git status *",
    'git commit -m "unclosed',
    "git commit -m 'unclosed",
    "git status & cat x",
    "git log |& cat",
    "git log > f",
    "git commit-tree x",
    "git diff",
    "cat x",
  ]) assert.equal(fin(c), false, JSON.stringify(c));
  for (const c of ['git add -A && git commit -m "fix: a, b; c | d # e > f & g"', "git -C ../w status", "git log --oneline -5 || git status", "git add src/x.ts; git commit -m 'it''s'", "git status\ngit log -1", "git commit -m 'a & b' && git log -1"]) assert.equal(fin(c), true, JSON.stringify(c));
  assert.equal(finalizationCommand("read", { command: "git status" }), false);
});

test("finalization_command_hash_or_backslash_refused: a long refused line is classified fast", () => {
  const t0 = Date.now();
  assert.equal(fin(`git commit -m ${"a ".repeat(20000)}!`), false);
  assert.equal(fin(`git commit -m ${"'a'".repeat(20000)}"`), false);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});
