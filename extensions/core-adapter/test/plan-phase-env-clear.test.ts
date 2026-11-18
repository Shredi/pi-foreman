// The launch flag PI_FOREMAN_PLAN_PHASE is removed from process.env when the plan phase ends, so a child shell no longer sees it:
// at a checkpoint approval, at `/foreman plan off` and at a plan-review PASS below heavy. A resumed pane that put the flag back
// from an older identity entry loses it again at session_start, and the identity entry is rewritten without `planPhase`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { world } from "./_r46world.ts";

const FLAG = "PI_FOREMAN_PLAN_PHASE";
type World = ReturnType<typeof world>;
type A = Awaited<ReturnType<World["adapter"]>>;
const identities = (w: World) => w.entries.filter((e) => e.customType === "pi-foreman-identity").map((e) => e.data as { planPhase?: string });

test("a checkpoint approval removes the flag from the env", async (t) => {
  const w = world(t);
  process.env[FLAG] = "1";
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  assert.equal(process.env[FLAG], "1", "set while the phase lasts");
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal(process.env[FLAG], undefined);
  await a.down();
  const b = await w.adapter("reload");
  assert.equal(process.env[FLAG], undefined);
  assert.equal((w.ceremonyEntries().at(-1)!.data as { planPhase: boolean }).planPhase, false, "a reload keeps the phase ended");
  assert.equal(await b.launch("builder"), undefined);
});

test("/foreman plan off removes the flag; /foreman plan does not set it", async (t) => {
  const w = world(t);
  process.env[FLAG] = "1";
  const a = await w.adapter("startup");
  await a.command("foreman", "plan");
  assert.equal(process.env[FLAG], "1");
  await a.command("foreman", "plan off");
  assert.equal(process.env[FLAG], undefined);
  await a.command("foreman", "plan");
  assert.equal(process.env[FLAG], undefined, "the owner's phase is not an env flag");
});

test("a plan-review PASS below heavy removes the flag from the env", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "standard" } });
  process.env[FLAG] = "1";
  const a: A = await w.adapter("startup");
  fs.appendFileSync(w.planFile, "\n## Decisions and assumptions\nNone.\n\n## Open questions\nNone.\n");
  await a.writeLedger("# Ledger: x\n\n- [ ] 1. item\n");
  await a.tool("foreman_triage")!.execute("tr", { tier: "standard", reason: "test" }, undefined, undefined, a.ctx);
  assert.equal(process.env[FLAG], "1");
  assert.equal(await a.review("PASS"), null);
  assert.equal(process.env[FLAG], undefined);
});

test("a resumed pane's flag is dropped at session_start when the phase ended; the identity entry loses planPhase", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  process.env.PI_INTERCOM_STABLE_ID = "fm-child-1";
  process.env[FLAG] = "1";
  const a = await w.adapter("startup");
  assert.equal(identities(w).at(-1)?.planPhase, "1");
  await a.command("foreman", "plan off");
  await a.down();
  const before = identities(w).length;
  process.env[FLAG] = "1"; // paneresume puts it back from the identity entry
  process.env.PI_INTERCOM_STABLE_ID = "fm-child-1";
  await w.adapter("resume");
  assert.equal(process.env[FLAG], undefined);
  assert.equal(identities(w).length, before + 1);
  assert.equal(identities(w).at(-1)?.planPhase, undefined, "a later resume does not bring the phase back");
});

test("a fork drops the flag but adds no identity entry", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  process.env.PI_INTERCOM_STABLE_ID = "fm-child-1";
  process.env[FLAG] = "1";
  const a = await w.adapter("startup");
  await a.command("foreman", "plan off");
  await a.down();
  const before = identities(w).length;
  process.env[FLAG] = "1";
  process.env.PI_INTERCOM_STABLE_ID = "fm-child-1";
  await w.adapter("fork");
  assert.equal(identities(w).length, before);
});

test("a phase still on keeps the flag at session_start", async (t) => {
  const w = world(t);
  process.env[FLAG] = "1";
  const a = await w.adapter("startup");
  await a.down();
  await w.adapter("resume");
  assert.equal(process.env[FLAG], "1");
});
