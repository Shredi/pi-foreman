// The protect dialog consequence text names who asks for writes and deploys (child with a route runs on a confident allow).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

async function rig(t: Parameters<typeof r11Rig>[0], confirm: (title: string, message: string) => Promise<boolean>) {
  const notes: string[] = [];
  const asked: { title: string; message: string }[] = [];
  const ui = {
    notify: (m: string) => void notes.push(m),
    confirm: (title: string, message: string) => (asked.push({ title, message }), confirm(title, message)),
    select: async () => undefined,
    input: async () => "",
    editor: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const cmds = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const r = await r11Rig(t, {}, { ctx: { ui, mode: "rpc" }, config: { presence: { enabled: false } }, piExtra: { registerCommand: (n: string, d: never) => void cmds.set(n, d) } });
  return { ...r, notes, asked, slash: (args: string): Promise<void> => cmds.get("foreman")!.handler(args, r.ctx) };
}

test("protect dialog: a child with a route to its parent is not named as asking; one with no route or a session without UI is", async (t) => {
  const r = await rig(t, async () => false);
  await r.slash("perms protect add host staging-*.example.net --user");
  const m = r.asked[0].message;
  assert.ok(m.includes("in a session with UI, or a child with a route to its parent, writes and deploys too"));
  assert.ok(m.includes("a child with no route to its parent, or a session without UI, asks for writes and deploys."));
  assert.doesNotMatch(m, /a child or a session without UI asks/);
});
