// The protect dialog in the owner-dialog shape (`/foreman perms protect`, index.ts protectEntry): new titles, the permission file as plain
// text, the consequence text whole, the 120 s timeout still declines.
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
const userFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "permissions.json");

test("protect dialog: add shows the new title, the file as plain text, the note and the whole consequence text", async (t) => {
  const r = await rig(t, async () => true);
  await r.slash("perms protect add host staging-*.example.net --note keep-out --user");
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].title, "Protect host staging-*.example.net?");
  const m = r.asked[0].message;
  assert.match(m, /^keep-out$/m);
  assert.match(m, /Check mode: +the global gate\.protected\.check/);
  assert.ok(m.includes(`File: ${userFile(r.agentDir)}`), "the permission file as a plain path");
  assert.ok(m.includes("an accepted check allow replaces your ask rules, the dangerous-class whitelist and the ask/deny mode"));
  assert.ok(m.includes("Floors and deny rules still apply."));
  assert.match(m, /Yes: the protection is written +No: nothing changes\s*$/);
  assert.doesNotMatch(r.asked[0].title + m, /\x1b/);
  assert.match(r.notes.at(-1)!, /^pi-foreman: protected: host staging-/);
});

test("protect dialog: remove shows the new title; No and a dismissed dialog change nothing", async (t) => {
  const yes = await rig(t, async () => true);
  await yes.slash("perms protect add host staging-*.example.net --user");
  await yes.slash("perms protect remove host staging-*.example.net --user");
  assert.equal(yes.asked[1].title, "Remove protection from host staging-*.example.net?");
  assert.match(yes.asked[1].message, /Its calls go back to your ask rules and the dangerous class\./);
  assert.match(yes.asked[1].message, /Yes: the protection is removed +No: nothing changes\s*$/);
  const no = await rig(t, async () => false);
  await no.slash("perms protect add host staging-*.example.net --user");
  assert.match(no.notes.at(-1)!, /not changed/);
  assert.equal(fs.existsSync(userFile(no.agentDir)), false);
  const gone = await rig(t, async () => undefined as unknown as boolean);
  await gone.slash("perms protect add host staging-*.example.net --user");
  assert.equal(fs.existsSync(userFile(gone.agentDir)), false);
});

test("protect dialog: an unanswered dialog still times out into a refusal after 120 s", async (t) => {
  const r = await rig(t, () => new Promise<boolean>(() => undefined));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = r.slash("perms protect add host staging-*.example.net --user");
    for (let i = 0; i < 5; i++) await new Promise<void>((res) => setImmediate(res));
    mock.timers.tick(121_000);
    await p;
  } finally {
    mock.timers.reset();
  }
  assert.match(r.notes.at(-1)!, /not changed/);
  assert.equal(fs.existsSync(userFile(r.agentDir)), false);
});

test("protect dialog (TUI): drawn through custom, the blocked label is the plain question, Yes is the first option", async (t) => {
  const customs: { blocked: { kind: string; message: string }; options: string[] }[] = [];
  const notes: string[] = [];
  const cmds = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const theme = { fg: (_t: string, s: string) => s, underline: (s: string) => s };
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  const ui = {
    theme,
    notify: (m: string) => void notes.push(m),
    confirm: async () => false,
    select: async () => undefined,
    input: async () => "",
    setStatus: () => undefined,
    setWidget: () => undefined,
    custom: async (factory: (...a: unknown[]) => { render(w: number): string[] }, o: { blocked: { kind: string; message: string } }) => {
      const c = factory({ requestRender: () => undefined }, theme, {}, () => undefined);
      customs.push({ blocked: o.blocked, options: c.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter((l) => l === "→ Yes" || l === "No") });
      return "Yes";
    },
  };
  const r = await r11Rig(t, {}, { ctx: { ui, mode: "tui" }, config: { presence: { enabled: false } }, piExtra: { registerCommand: (n: string, d: never) => void cmds.set(n, d) } });
  await cmds.get("foreman")!.handler("perms protect add host staging-*.example.net --user", r.ctx);
  assert.equal(customs.length, 1);
  assert.deepEqual(customs[0].blocked, { kind: "permission", message: "Protect host staging-*.example.net?" });
  assert.deepEqual(customs[0].options, ["→ Yes", "No"]);
  assert.match(notes.at(-1)!, /^pi-foreman: protected: host staging-/);
});
