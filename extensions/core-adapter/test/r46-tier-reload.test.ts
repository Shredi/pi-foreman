// R46 item 10(b): a reload never lowers the tier. The ceremony-state entry carries the effective tier and the source of its
// last change; on restore the higher of that tier and userTier wins, unless the last change was the owner's /ceremony.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./_r46world.ts";

type Entry = { tier?: string; tierSource?: string; userTier?: string | null };
const last = (w: ReturnType<typeof world>): Entry => w.ceremonyEntries().at(-1)!.data as Entry;

test("/ceremony trivial, auto escalation to standard, reload: tier stays standard", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.command("ceremony", "trivial");
  assert.equal(await a.launch("explorer"), undefined);
  await a.launch("explorer"); // second launch: auto standard
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
  assert.equal(last(w).tier, "standard");
  assert.equal(last(w).tierSource, "auto");
  assert.equal(last(w).userTier, "trivial");
  await a.down();
  const b = await w.adapter("reload");
  await b.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
});

test("auto escalation without /ceremony, reload: tier unchanged", async (t) => {
  const w = world(t, { ceremony: { default: "trivial" } });
  const a = await w.adapter("startup");
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: trivial/);
  await a.launch("explorer");
  await a.launch("explorer"); // second launch: auto standard
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
  await a.down();
  const b = await w.adapter("reload");
  await b.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
  const c = await w.adapter("resume");
  await c.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
});

// the rig has no hook for a prompt signal or a counted file write, so the raise to heavy comes from the ledger header (a non-user source)
test("/ceremony standard after a heavy raise, reload: tier stays standard", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  await a.writeLedger("# x\n\nTier: heavy\n\n- [ ] 1. work\n");
  await a.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: heavy/);
  await a.command("ceremony", "standard");
  assert.equal(last(w).tier, "standard");
  assert.equal(last(w).tierSource, "user");
  await a.down();
  const b = await w.adapter("reload");
  await b.command("ceremony", "");
  assert.match(w.notes.at(-1) ?? "", /Current ceremony tier: standard/);
});
