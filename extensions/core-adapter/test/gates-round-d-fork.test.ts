// Gates round PR D revision: a fork keeps its parent's checkout fingerprint; a clean start has none; a dirty submodule with a quoted path is fingerprinted.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { checkoutBaseline, statusPaths } from "../trivial.ts";
import { end, git, launch, settle, setup, tick } from "./_hsrig.ts";
import type { Rig, World } from "./_hsrig.ts";

const noChangeTrace = async (w: World) => (await w.traceEvents()).some((e) => e.event === "ceremony_gate" && e.reason === "no_change");
const builderChanges = async (a: Rig, w: World) => {
  const b = await launch(a, "builder", "build the widget");
  assert.equal(b.blocked, null, String(b.blocked));
  fs.writeFileSync(path.join(w.project, "widget.ts"), "export {};\n");
  await end(a, b, "builder", "done");
};
const dirtyFile = (project: string) => fs.writeFileSync(path.join(project, "pre.txt"), "dirty\n");

test("13: a fork of a session whose builder changed files (no review) is still refused", async (t) => {
  const { a, w } = await setup(t, { tier: "heavy" });
  await builderChanges(a, w);
  assert.match(await settle(a), /finish refused.*reviewer/);
  const f = await w.adapter("fork");
  assert.match(await settle(f), /finish refused.*reviewer/);
  assert.ok(!(await noChangeTrace(w)));
});

test("13: a fork of an untouched dirty checkout still finishes plan-only", async (t) => {
  const { a, w } = await setup(t, { tier: "heavy", before: dirtyFile });
  const plan = path.join(w.project, ".workflow", "plan-extra.md");
  fs.writeFileSync(plan, "# Extra plan\n");
  assert.equal((await a.call("write", { path: plan, content: "# Extra plan\n" })).block, undefined);
  await tick(100);
  const f = await w.adapter("fork");
  assert.equal(await settle(f), "");
  assert.ok(await noChangeTrace(w));
});

test("13: a session that starts clean and is later dirtied by someone else's hand is refused", async (t) => {
  const { a, w } = await setup(t, { tier: "heavy" });
  fs.writeFileSync(path.join(w.project, "outside.txt"), "x\n");
  assert.match(await settle(a), /requires builder, reviewer/);
  assert.ok(!(await noChangeTrace(w)));
});

test("13: the fingerprint is null for a clean checkout", async (t) => {
  const { w } = await setup(t, { tier: "heavy" });
  assert.equal(await checkoutBaseline(w.project, ".workflow/scratch"), null);
});

test("13: statusPaths reads -z output unquoted (non-ASCII names, renames)", () => {
  const z = " M vendor/süb\0?? a b.txt\0R  new.txt\0old.txt\0";
  assert.deepEqual([...statusPaths(z)], ["vendor/süb", "a b.txt", "new.txt"]);
});

test("13: a dirty submodule with a non-ASCII path is fingerprinted (a further edit changes it)", async (t) => {
  const { w } = await setup(t, { tier: "heavy" });
  const sub = path.join(path.dirname(w.project), "sub-src");
  fs.mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-q", "-m", "sub");
  git(w.project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/süb");
  git(w.project, "commit", "-q", "-m", "with submodule");
  fs.writeFileSync(path.join(w.project, "vendor", "süb", "s.txt"), "dirty\n");
  const one = await checkoutBaseline(w.project, ".workflow/scratch");
  assert.ok(one);
  fs.writeFileSync(path.join(w.project, "vendor", "süb", "s.txt"), "dirty twice\n");
  assert.notEqual(await checkoutBaseline(w.project, ".workflow/scratch"), one);
});
