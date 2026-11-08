// Item 9 wired: the missing reviewer-pair notice once per model at session start, and the /foreman doctor WARN line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const roles = { explorer: { model: "pa/explorer-m" }, builder: { model: "pa/builder-m" }, reviewer: { model: "pa/mid" }, finalizer: { model: "pa/finalizer-m" }, foreman: { model: "pa/mid" } };
const config = { providers: { pa: { roles, cache: { ttlSeconds: 300, billing: "token" } } } };

async function rig(t: Parameters<typeof r11Rig>[0], ceremony: Record<string, unknown>) {
  const notes: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) };
  const r = await r11Rig(t, ceremony, {
    config,
    ctx: { model: { provider: "pa", id: "mid" }, modelRegistry: reg, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "allow once", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerTool: () => undefined, registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c), appendEntry: () => undefined },
    deps: { piVersion: async () => "1.4.0" },
  });
  return { r, notes, doctor: async () => { notes.length = 0; await commands.get("foreman")!.handler("doctor", r.ctx); return notes.join("\n"); } };
}

const KEY = /ceremony\.reviewModel\["pa\/mid"\]/;

test("item 9: no pair for the live foreman model: one session notice, and a doctor WARN naming the key", async (t) => {
  const x = await rig(t, {});
  const pre = x.notes.filter((n) => KEY.test(n));
  assert.equal(pre.length, 1, x.notes.join("\n"));
  await x.r.fire("model_select", { model: { provider: "pa", id: "mid" }, source: "set" });
  assert.equal(x.notes.filter((n) => KEY.test(n)).length, 1, "the same model again does not repeat it");
  const out = await x.doctor();
  assert.match(out, /WARN no reviewer pair for foreman model pa\/mid/);
  assert.match(out, KEY);
});

test("item 9: a pair covering the live foreman model: no notice and no doctor WARN", async (t) => {
  const x = await rig(t, { reviewModel: { "pa/mid": "pb/other" } });
  assert.equal(x.notes.some((n) => /no reviewer pair/.test(n)), false, x.notes.join("\n"));
  assert.doesNotMatch(await x.doctor(), /no reviewer pair/);
});
