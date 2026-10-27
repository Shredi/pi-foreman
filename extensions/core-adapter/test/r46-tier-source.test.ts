// R46 item 4: one tier source. `/ceremony <tier>` sets a sticky userTier that outranks the ledger `Tier:` line and
// foreman_triage; automatic escalations from a new signal still apply and keep it; only the next /ceremony replaces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeSpawn, escalate, initialCeremony, onFileChanged, tierLine, userOverride } from "../ceremony.ts";
import { foremanTriage } from "../triage.ts";
import { planRequired, world } from "./_r46world.ts";

test("escalate(ledger) never raises the tier above the user's", () => {
  const user = userOverride(initialCeremony("standard"), "standard");
  const after = escalate(user, "heavy", "ledger", "ledger header Tier: heavy");
  assert.equal(after.tier, "standard");
  assert.equal(after.userTier, "standard");
  assert.match(tierLine(after), /set by the user \(ledger says heavy\)/);
});

test("user trivial, second launch -> auto standard; a later ledger refresh stays standard", () => {
  let c = userOverride(initialCeremony("heavy"), "trivial");
  c = beforeSpawn(c, ["explorer"]);
  c = { ...c, spawns: 1 };
  c = beforeSpawn(c, ["explorer"]);
  assert.equal(c.tier, "standard");
  assert.equal(c.userTier, "trivial");
  c = escalate(c, "heavy", "ledger", "ledger header Tier: heavy");
  assert.equal(c.tier, "standard", "the ledger cannot raise it further");
});

test("automatic escalation from a signal still applies and keeps userTier", () => {
  let c = userOverride(initialCeremony("heavy"), "standard");
  c = onFileChanged(c, "/w/a.ts", 1);
  c = onFileChanged(c, "/w/b.ts", 1);
  assert.equal(c.tier, "heavy");
  assert.equal(c.userTier, "standard");
});

test("foreman_triage cannot raise the tier above the user's; the same or a lower request passes; the next /ceremony replaces userTier", () => {
  const user = userOverride(initialCeremony("heavy"), "standard");
  const raise = foremanTriage(user, "heavy", "big");
  assert.ok("error" in raise);
  assert.match((raise as { error: string }).error, /\/ceremony/);
  const same = foremanTriage(user, "standard", "ok");
  assert.ok("state" in same);
  assert.equal((same as { state: { userTier?: string } }).state.userTier, "standard");
  const again = userOverride(user, "heavy");
  assert.equal(again.userTier, "heavy");
  assert.equal(escalate(again, "heavy", "ledger", "x").tier, "heavy");
});

test("without a /ceremony the ledger still raises the tier (unchanged)", () => {
  const c = escalate(initialCeremony("standard"), "heavy", "ledger", "ledger header Tier: heavy");
  assert.equal(c.tier, "heavy");
  assert.equal(c.userTier, undefined);
});

test("/ceremony standard with a heavy ledger: the builder is not refused for a missing plan", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger("# x\n\nTier: heavy\n\n- [ ] 1. work\n");
  assert.ok(planRequired(await a.launch("builder")), "heavy from the ledger: plan required");
  await a.command("ceremony", "standard");
  await a.writeLedger("# x\n\nTier: heavy\n\n- [ ] 1. work\n"); // a ledger refresh
  const res = await a.launch("builder");
  assert.ok(!planRequired(res), JSON.stringify(res));
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /standard \(set by the user \(ledger says heavy\)\)/);
});

test("/ceremony standard, reload, ledger heavy: stays standard", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger("# x\n\nTier: heavy\n\n- [ ] 1. work\n");
  await a.command("ceremony", "standard");
  assert.ok(w.ceremonyEntries().some((e) => (e.data as { userTier?: string }).userTier === "standard"), "persisted in the session entry");
  await a.down();
  const b = await w.adapter("reload");
  await b.writeLedger("# x\n\nTier: heavy\n\n- [ ] 1. work\n");
  assert.ok(!planRequired(await b.launch("builder")));
  await b.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
  // resume restores it too
  const c = await w.adapter("resume");
  await c.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
});

test("/ceremony trivial, second launch (auto standard), ledger refresh stays standard", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.command("ceremony", "trivial");
  assert.equal(await a.launch("explorer"), undefined);
  await a.launch("explorer");
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
  await a.writeLedger("# x\n\nTier: heavy\n\n- [ ] 1. work\n");
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
});
