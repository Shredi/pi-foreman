// `/foreman flag-ask` with tracing off names what happened to the report: the same command flagged twice in one session says the report already exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { readRows, storeFor } from "../reports.ts";

const ESCALATE = JSON.stringify({ verdict: "owner", class: "data-loss", reason: "unsure" });
const registry = {
  find: () => ({ id: "m" }),
  getProviderAuthStatus: () => ({ configured: false }),
  complete: async () => ({ content: [{ type: "text", text: ESCALATE }], stopReason: "stop", usage: { input: 1, output: 1 } }),
};

test("flag-ask notice, trace off, second flag of the same command: the report already exists", async (t) => {
  const notes: string[] = [];
  const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
  const ui = { notify: (m: string) => notes.push(m), confirm: async () => false, select: async () => "allow once", input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, {
    ctx: { modelRegistry: registry, ui },
    config: { presence: { enabled: false }, trace: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: {} } } },
    piExtra: { registerCommand: (n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) => void commands.set(n, d) },
  });
  assert.equal(await r.call("bash", { command: "git branch -D old-topic" }), undefined);
  await commands.get("foreman")!.handler("flag-ask", r.ctx);
  await commands.get("foreman")!.handler("flag-ask", r.ctx);
  const flagged = notes.filter((n) => /flagged/.test(n));
  assert.equal(flagged.length, 2, notes.join("\n"));
  assert.ok(flagged[0].endsWith("the report was written)."), flagged[0]);
  assert.ok(flagged[1].endsWith("the report already exists)."), flagged[1]);
  assert.equal(readRows(storeFor(r.project).file).length, 1);
});
