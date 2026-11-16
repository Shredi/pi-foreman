// The child owns its plan (PR 4): in a session opened by a parent (handoff dir and parent intercom id set), the heavy checkpoint is
// the owner's dialog in the session's own pane, as in a session without a parent. No file from the parent approves: a `ruling.md` or
// `ruling-plan.md` in the handoff dir approves nothing, not at the checkpoint and not on a reload. The dialog holds the owner blocked
// state (kind checkpoint) while open; the approval survives a reload; with no UI the checkpoint stays pending; `ceremony.checkpoint:
// parent` is refused with its message.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { planRequired, tick, world } from "./_r46world.ts";
import type { Block } from "./_r46world.ts";

const pending = (r: Block): boolean => r?.block === true && /\[launch_refused:checkpoint_pending\]/.test(r.reason ?? "");

test("heavy child: no parent file approves (checkpoint, no UI, reload); the owner's dialog does, and its approval survives a reload and a lost session file", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  w.rule("ruling-plan.md", "APPROVED\n");
  w.rule("ruling.md", "APPROVED\n");
  // no UI: the checkpoint stays pending whatever the handoff dir holds, and builders stay refused
  const ctx = a.ctx as { hasUI: boolean; ui: { select: (...x: unknown[]) => Promise<string | undefined> } };
  let asked = 0;
  const select = ctx.ui.select;
  ctx.ui.select = async (...x: unknown[]) => (asked++, select(...x));
  ctx.hasUI = false;
  // the parent's files arrive as notes like any handoff file (the checkpoint press picks them up first); they approve nothing
  const note = await a.checkpoint();
  assert.equal(note.decision, "pending");
  assert.match(note.text, /newer ruling arrived/);
  const none = await a.checkpoint();
  assert.equal(none.decision, "pending");
  assert.doesNotMatch(none.text, /ruling-plan\.md|ruling\.md|foreman_wait/, "no pointer to a parent's verdict file");
  assert.equal(asked, 0);
  assert.ok(pending(await a.launch("builder")), "no UI: builders refused");
  // the owner's dialog opens even though the parent's files read APPROVED; revise approves nothing
  ctx.hasUI = true;
  w.state.answer = "revise";
  assert.equal((await a.checkpoint()).decision, "revise");
  assert.equal(asked, 1, "the dialog ran");
  assert.ok((await a.launch("builder"))?.block, "a revise leaves builders refused");
  await a.down();
  // a reload with the parent's APPROVED files still beside the plan restores no approval (round-state.json holds this plan)
  const b = await w.adapter("reload");
  assert.ok((await b.launch("builder"))?.block, "no parent file approves on reload");
  w.state.answer = "approve";
  const ok = await b.checkpoint();
  assert.equal(ok.decision, "approve");
  assert.equal((w.ceremonyEntries().at(-1)!.data as { plan: { source: string } }).plan.source, "dialog");
  assert.equal(await b.launch("builder"), undefined, "the owner's approval opens the gate");
  await b.down();
  const c = await w.adapter("reload");
  assert.equal(await c.launch("builder"), undefined, "the dialog approval survives a reload");
  await c.down();
  // the session file is gone (a new branch): the approval comes back from the approval store, also in a session with a parent
  w.entries.length = 0;
  for (const f of ["ruling.md", "ruling-plan.md"]) fs.rmSync(path.join(w.handoff, f));
  const d = await w.adapter("resume");
  assert.equal(await d.launch("builder"), undefined, "the owner's own approval survives without the session entry");
});

test("an entry recorded from a parent's verdict file restores nothing, and the dialog holds the owner blocked state while open", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  w.rule("ruling-plan.md", "APPROVED\n");
  // an older harness recorded the approval as coming from ruling-plan.md: such an entry is dropped when read
  w.entries.push({ type: "custom", customType: "pi-foreman-ceremony-state", data: { v: 1, plan: { topic: "widget", path: w.planFile, hash: w.hash(), status: "approved", by: "rig", at: new Date().toISOString(), source: "ruling-plan" }, lineages: [], userTier: null, tier: null, tierSource: null, planPhase: false, reviews: [] } });
  await a.down();
  const b = await w.adapter("reload");
  assert.ok(planRequired(await b.launch("builder")) || pending(await b.launch("builder")), "an approval from a parent's file does not come back");
  // the dialog: owner blocked (kind checkpoint) in the live file and the trace while it is open, released after the answer
  const ctx = b.ctx as { ui: { select: (...x: unknown[]) => Promise<string | undefined> } };
  let answer: (v: string) => void = () => undefined;
  let opened: () => void = () => undefined;
  const isOpen = new Promise<void>((r) => (opened = r));
  ctx.ui.select = () => new Promise<string | undefined>((r) => ((answer = r), opened()));
  const call = b.checkpoint();
  await isOpen;
  const live = path.join(w.project, "..", "agent", "pi-foreman", "state", "live");
  const liveOf = (): Record<string, unknown> => {
    const f = fs.readdirSync(live).find((n) => n.endsWith(".json"));
    return f ? (JSON.parse(fs.readFileSync(path.join(live, f), "utf8")) as Record<string, unknown>) : {};
  };
  const until = async (ok: (x: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 120; i++) {
      const x = liveOf();
      if (ok(x)) return x;
      await tick(25);
    }
    return liveOf();
  };
  const held = await until((x) => x.blockedOn === "owner");
  assert.equal(held.blockedOn, "owner");
  assert.equal(held.blockedKind, "checkpoint");
  const opens = (await w.traceEvents()).filter((e) => e.event === "blocked_open");
  assert.ok(opens.some((e) => e.on === "owner" && e.kind === "checkpoint"), "blocked_open owner checkpoint");
  assert.equal((await w.traceEvents()).some((e) => e.event === "blocked_closed" && e.kind === "checkpoint"), false, "still open");
  answer("approve");
  assert.equal((await call).decision, "approve");
  const after = await until((x) => !("blockedOn" in x));
  assert.equal("blockedOn" in after, false, "released after the answer");
  assert.ok((await w.traceEvents()).some((e) => e.event === "blocked_closed" && e.on === "owner" && e.kind === "checkpoint"));
});

test("ceremony.checkpoint: parent is refused with its message; no dialog opens and builders stay refused", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { checkpoint: "parent" } });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  w.rule("ruling-plan.md", "APPROVED\n");
  const ctx = a.ctx as { ui: { select: (...x: unknown[]) => Promise<string | undefined> } };
  let asked = 0;
  ctx.ui.select = async () => (asked++, "approve");
  const r = await a.checkpoint();
  assert.equal(r.decision, "refused");
  assert.match(r.text, /\[checkpoint_parent\]/);
  assert.match(r.text, /ceremony\.checkpoint "parent" is no longer supported/);
  assert.equal(asked, 0);
  const first = await a.launch("builder"); // the press of a launch first picks up the parent's file as a note
  assert.ok(first?.block);
  assert.ok(planRequired(first) || planRequired(await a.launch("builder")));
});
