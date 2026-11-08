// The finish gate's progress (builder runs, reviewer verdicts, PASS mark) and the checkout of each review survive /reload of the
// same session (ceremony-state entry `gate`, `cwd` per review); a new session and a fork start fresh; an entry from before
// rebuilds from its PASS review; a revision after the reload still re-opens the reviewer step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { prGateRefusal, reviewsOfEntry } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;
type World = ReturnType<typeof world>;

const settle = async (a: Rig): Promise<Settle> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as Settle;
const refusal = (r: Settle): string => (r?.entries ?? []).find((e) => e.customType === "pi-foreman-ceremony-gate")?.content ?? "";
const standard = async (t: Parameters<typeof world>[0]) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.command("ceremony", "standard");
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n");
  return { w, a };
};

async function run(a: Rig, agent: string, output: string, task = `${agent} the widget`, extra: Record<string, unknown> = {}, cwd?: string): Promise<void> {
  const r = await a.agentLaunch(agent, task, extra);
  assert.equal(r.blocked, null);
  a.endRunAs(r.id, agent, output, cwd);
  await tick(150);
}
const buildAndPass = async (a: Rig) => {
  await run(a, "builder", "done");
  await run(a, "reviewer", "Overall verdict: PASS", "[pre-pr] review the branch");
};
const reload = async (w: World, a: Rig, reason = "reload"): Promise<Rig> => {
  await a.down();
  return w.adapter(reason);
};
const lastEntry = (w: World) => w.ceremonyEntries().at(-1)!.data as Record<string, unknown> & { gate?: unknown; reviews: Record<string, unknown>[] };

test("without a reload the finish is refused until builder and reviewer ran (baseline)", async (t) => {
  const { a } = await standard(t);
  assert.match(refusal(await settle(a)), /requires builder, reviewer/);
  await buildAndPass(a);
  assert.equal(refusal(await settle(a)), "");
});

test("reload after a builder run and a reviewer PASS: the finish is allowed", async (t) => {
  const { w, a } = await standard(t);
  await buildAndPass(a);
  const b = await reload(w, a);
  assert.equal(refusal(await settle(b)), "", "no 'requires builder, reviewer' after the reload");
  const c = await reload(w, b);
  assert.equal(refusal(await settle(c)), "", "and after a second reload");
});

test("a new session id does not inherit the progress; neither does a fork", async (t) => {
  const { w, a } = await standard(t);
  await buildAndPass(a);
  const fork = await reload(w, a, "fork");
  assert.match(refusal(await settle(fork)), /requires builder, reviewer/);
  const other = await standard(t);
  assert.match(refusal(await settle(other.a)), /requires builder, reviewer/);
});

test("an entry from before the gate was recorded (PASS review, no gate, no cwd) rebuilds the progress; without a PASS it stays refused", async (t) => {
  const { w, a } = await standard(t);
  await buildAndPass(a);
  const e = lastEntry(w);
  assert.ok(e.gate, "the gate is recorded");
  delete e.gate;
  for (const r of e.reviews) delete r.cwd;
  const b = await reload(w, a);
  assert.equal(refusal(await settle(b)), "", "rebuilt from the PASS review");

  const f = await standard(t);
  await run(f.a, "builder", "done");
  await run(f.a, "reviewer", "Overall verdict: FAIL", "[pre-pr] review the branch");
  const fe = lastEntry(f.w);
  delete fe.gate;
  const g = await reload(f.w, f.a);
  assert.match(refusal(await settle(g)), /requires builder, reviewer/, "a FAIL rebuilds nothing");

  const h = await standard(t);
  await run(h.a, "builder", "done");
  delete lastEntry(h.w).gate;
  const i = await reload(h.w, h.a);
  assert.match(refusal(await settle(i)), /requires builder, reviewer/, "no review at all rebuilds nothing");
});

test("a malformed gate field is ignored (no PASS to rebuild from: refused)", async (t) => {
  const { w, a } = await standard(t);
  await run(a, "builder", "done");
  await run(a, "reviewer", "Overall verdict: FAIL", "[pre-pr] review the branch");
  lastEntry(w).gate = { steps: { builder: "x" }, reviewGate: 3 };
  const b = await reload(w, a);
  assert.match(refusal(await settle(b)), /requires builder, reviewer/);
});

test("a builder launch after the reload marks the restored PASS stale: the reviewer is required again", async (t) => {
  const { w, a } = await standard(t);
  await buildAndPass(a);
  const b = await reload(w, a);
  assert.equal(refusal(await settle(b)), "");
  const r = await b.agentLaunch("builder", "builder revise the widget");
  assert.equal(r.blocked, null);
  b.endRunAs(r.id, "builder", "revised");
  await tick(150);
  const text = refusal(await settle(b));
  assert.match(text, /requires reviewer/);
  assert.doesNotMatch(text, /builder,/);
  assert.match(text, /re-review needed: revised after the last PASS/);
});

function repo(prefix: string, parent: string = os.tmpdir()): { dir: string; g: (...a: string[]) => string; commit: (m: string) => string } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, prefix)));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  const commit = (m: string) => (g("commit", "-q", "--allow-empty", "-m", m), g("rev-parse", "HEAD"));
  commit("chore: a");
  return { dir, g, commit };
}

const gate = async (w: World, session: string, sib: string) => prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: session, input: {}, checkout: { cwd: sib, records: reviewsOfEntry(lastEntry(w).reviews) } });

test("#129: a PASS in a sibling checkout survives the reload: same head allowed, new head cwd_stale, other session cwd_unreviewed", async (t) => {
  const { w, a } = await standard(t);
  const sib = repo("pf-gsr-sib-", w.project); // a nested checkout: its own git toplevel, inside the project so a launch there needs no dialog
  const rl = await a.agentLaunch("reviewer", "[pre-pr] review the sibling", { cwd: sib.dir });
  assert.equal(rl.blocked, null);
  a.endRunAs(rl.id, "reviewer", "Overall verdict: PASS", sib.dir);
  await tick(150);
  assert.ok(lastEntry(w).reviews.some((r) => r.cwd === sib.dir), "the checkout is persisted with the record");
  const session = repo("pf-gsr-ses-");
  t.after(() => rmTestTmp(session.dir));
  assert.equal(await gate(w, session.dir, sib.dir), null, "before the reload");
  await reload(w, a);
  assert.equal(await gate(w, session.dir, sib.dir), null, "the entry written before the reload opens the sibling");
  const b = await w.adapter("reload");
  assert.ok(lastEntry(w).reviews.some((r) => r.cwd === sib.dir), "a reload keeps the checkout of the record");
  void b;
  sib.commit("chore: b");
  assert.equal((await gate(w, session.dir, sib.dir))?.reason, "cwd_stale", "a different head is stale");
  const other = await standard(t);
  assert.equal((await gate(other.w, session.dir, sib.dir))?.reason, "cwd_unreviewed", "another session has no record");
});
