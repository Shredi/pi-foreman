// `/foreman steward on|off|status` and `model: "top"` through the real adapter hooks: the feature is off by default, the steward fact comes from session state.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { lockFileOf, STEWARD_ENTRY, STEWARD_TEXT_TYPE } from "../steward.ts";
import { recordReport, storeFor } from "../reports.ts";
import { START_NOTE_TYPE } from "../startnote.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

type T = { after(fn: () => void | Promise<void>): void };
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

async function rig(t: T, config: Record<string, unknown> = {}) {
  const commands = new Map<string, Command>();
  const notes: string[] = [];
  const sent: { customType: string; content: string }[] = [];
  const entries: { type: string; data: unknown }[] = [];
  const r = await r11Rig(t, {}, {
    config: { presence: { enabled: false }, ...config },
    ctx: { ui: { notify: (m: string) => notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerCommand: (n: string, d: Command) => void commands.set(n, d),
      sendMessage: (m: { customType: string; content: string }) => void sent.push(m),
      appendEntry: (type: string, data: unknown) => void entries.push({ type, data }),
    },
  });
  return { r, notes, sent, entries, command: (args: string) => commands.get("foreman")!.handler(args, r.ctx) };
}

const TOP = { agent: "explorer", task: "look", model: "top", reason: "steward pass" };

test("off by default: on is refused with one line and nothing is registered", async (t) => {
  const a = await rig(t);
  const before = a.notes.length;
  await a.command("steward on");
  assert.equal(a.notes.length, before + 1, "one line");
  assert.match(a.notes[before], /steward is off/);
  assert.equal(fs.existsSync(lockFileOf(a.r.project)), false);
  assert.equal(a.sent.filter((m) => m.customType === STEWARD_TEXT_TYPE).length, 0);
  assert.equal(a.entries.filter((e) => e.type === STEWARD_ENTRY).length, 0);
});

test("on sends the instruction once as a message, persists, takes the lock; off gives it back", async (t) => {
  const a = await rig(t, { steward: { enabled: true } });
  await a.command("steward on");
  assert.equal(a.sent.filter((m) => m.customType === STEWARD_TEXT_TYPE).length, 1);
  assert.match(a.sent[0].content, /steward/);
  assert.equal(a.entries.at(-1)?.type, STEWARD_ENTRY);
  assert.equal(fs.existsSync(lockFileOf(a.r.project)), true);
  await a.command("steward status");
  assert.match(a.notes.at(-1) ?? "", /is the steward/);
  await a.command("steward off");
  assert.equal(fs.existsSync(lockFileOf(a.r.project)), false);
  await a.command("steward bogus");
  assert.match(a.notes.at(-1) ?? "", /Usage: \/foreman steward/);
});

test("model top is refused outside the steward session and allowed inside it", async (t) => {
  const a = await rig(t, { steward: { enabled: true } });
  const no = (await a.r.launch({ ...TOP })).res;
  assert.equal(no?.block, true);
  assert.match(no?.reason ?? "", /\[top_not_allowed\]/);
  assert.equal(a.r.events("launch_refused").some((e) => e.reason === "top_not_allowed"), true);
  await a.command("steward on");
  const yes = (await a.r.launch({ ...TOP })).res;
  assert.ok(!(yes?.reason ?? "").includes("top_not_allowed"), yes?.reason);
  const builder = (await a.r.launch({ ...TOP, agent: "builder" })).res;
  assert.match(builder?.reason ?? "", /top_not_allowed/);
  const bare = (await a.r.launch({ agent: "explorer", task: "look", model: "top" })).res;
  assert.match(bare?.reason ?? "", /needs a reason/);
});

test("the start note is not sent in the steward session", async (t) => {
  const a = await rig(t, { steward: { enabled: true } });
  for (let i = 0; i < 2; i++) recordReport({ cwd: a.r.project, role: "foreman", session: `seed-${i}`, runId: null, source: "agent", repo: null, workspace: null, branch: null }, { kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked" }, storeFor(a.r.project));
  await a.command("steward on");
  for (const h of a.r.handlersOf("before_agent_start")) {
    const res = (await h({ prompt: "go", type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections: {} } }, a.r.ctx)) as { message?: { customType: string } } | undefined;
    assert.notEqual(res?.message?.customType, START_NOTE_TYPE);
  }
});
