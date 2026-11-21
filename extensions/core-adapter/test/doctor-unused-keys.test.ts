// /foreman doctor: one "no longer used" INFO per accepted-but-dead key (gate.mode, gate.askTimeoutMs, gate.readClear, gate.readonlyClear,
// retro.proposalMinReviews), shown only when a layer sets the key; the shipped defaults set none of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0];
type Cmd = { handler: (args: string, ctx: unknown) => Promise<void> };

async function doctor(t: T, config: Record<string, unknown> = {}): Promise<string> {
  const commands = new Map<string, Cmd>();
  const notes: string[] = [];
  const c = await r11Rig(t, {}, {
    config,
    piExtra: { registerCommand: (n: string, cmd: Cmd) => void commands.set(n, cmd) },
    ctx: { ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
  });
  await commands.get("foreman")!.handler("doctor", c.ctx);
  return notes[notes.length - 1];
}

const unused = (text: string, key: string): string[] => text.split("\n").filter((l) => l.startsWith(`INFO ${key} is no longer used`));

test("doctor: a defaults-only config prints no unused-key INFO", async (t: T) => {
  const text = await doctor(t);
  for (const k of ["gate.mode", "gate.askTimeoutMs", "gate.readClear", "gate.readonlyClear", "retro.proposalMinReviews"]) assert.deepEqual(unused(text, k), [], k);
});

for (const [key, config] of [
  ["gate.mode", { gate: { mode: "full" } }],
  ["gate.askTimeoutMs", { gate: { askTimeoutMs: 60000 } }],
  ["gate.readClear", { gate: { readClear: false } }],
  ["gate.readonlyClear", { gate: { readonlyClear: false } }],
  ["retro.proposalMinReviews", { retro: { proposalMinReviews: 3 } }],
] as const) {
  test(`doctor: a user-layer ${key} prints one INFO and the config still loads`, async (t: T) => {
    const text = await doctor(t, config);
    assert.equal(unused(text, key).length, 1, text);
    assert.match(text, /^OK +config loaded \(0 warning\(s\)\)$/m);
  });
}
