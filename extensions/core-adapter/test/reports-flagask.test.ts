// `/foreman flag-ask` also writes a report (index.ts flagReport): the command masked and cut to 300 characters, the full command stays in the trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { readRows, storeFor } from "../reports.ts";

const ESCALATE = JSON.stringify({ verdict: "unsure", reason: "unsure" });
// C: a line that asks the owner is a judge-first one (git branch -D) the judge is unsure about; an install runs with no ask
const registry = {
  find: () => ({ id: "m" }),
  getProviderAuthStatus: () => ({ configured: false }),
  complete: async () => ({ content: [{ type: "text", text: ESCALATE }], stopReason: "stop", usage: { input: 1, output: 1 } }),
};

test("flag-ask: one owner report of kind permission with a masked, capped command; the trace has the full one", async (t) => {
  const notes: string[] = [];
  const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
  const ui = { notify: (m: string) => notes.push(m), confirm: async () => false, select: async () => "allow once", input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, {
    ctx: { modelRegistry: registry, ui },
    config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: {} } } },
    piExtra: { registerCommand: (n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) => void commands.set(n, d) },
  });
  await commands.get("foreman")!.handler("flag-ask", r.ctx);
  assert.equal(readRows(storeFor(r.project).file).length, 0, "nothing answered yet");
  const cmd = `git branch -D old-topic --token=abcdef1234567890 ${"x".repeat(400)}`;
  assert.equal(await r.call("bash", { command: cmd }), undefined);
  await commands.get("foreman")!.handler("flag-ask needless", r.ctx);
  const rows = readRows(storeFor(r.project).file);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual([row.kind, row.source, row.role, row.suggest], ["permission", "owner", "foreman", "needless"]);
  assert.ok(typeof row.subject === "string" && row.subject.length > 0);
  assert.ok(String(row.what).length <= 300 && !String(row.what).includes("abcdef1234567890"), String(row.what));
  const flag = r.events("ask_flag").at(-1)!;
  assert.ok(String(flag.command).length > 300, "the trace keeps the whole command");
  assert.ok(!String(flag.command).includes("abcdef1234567890"));
  assert.ok(notes.some((n) => /flagged/.test(n)));
});

for (const [name, config, tail] of [
  ["trace off, report written", { trace: { enabled: false } }, "; tracing is off, the report was written)."],
  ["trace off, report off", { trace: { enabled: false }, retro: { report: false } }, "; tracing is off, nothing was written)."],
] as const) {
  test(`flag-ask notice, ${name}: it says what was written`, async (t) => {
    const notes: string[] = [];
    const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
    const ui = { notify: (m: string) => notes.push(m), confirm: async () => false, select: async () => "allow once", input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
    const r = await r11Rig(t, {}, {
      ctx: { modelRegistry: registry, ui },
      config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: {} } }, ...config },
      piExtra: { registerCommand: (n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) => void commands.set(n, d) },
    });
    assert.equal(await r.call("bash", { command: "git branch -D old-topic" }), undefined);
    await commands.get("foreman")!.handler("flag-ask", r.ctx);
    const note = notes.find((n) => /flagged/.test(n))!;
    assert.ok(note.endsWith(tail), note);
    assert.equal(readRows(storeFor(r.project).file).length, tail.includes("report was written") ? 1 : 0);
  });
}
