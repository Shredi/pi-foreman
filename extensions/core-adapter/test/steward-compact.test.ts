// Steward, second revision: the instruction text is sent again after a compaction, `retro` is steward-only, the retro answer holds no command text, a throwing settings read keeps the timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retroCounters } from "../reportstool.ts";
import { STEWARD_ENTRY, STEWARD_TEXT_TYPE, StewardWatch, stewardSettings, type StewardDeps, type StewardEntry } from "../steward.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

type T = { after(fn: () => void | Promise<void>): void };
const INSTRUCTION = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "instructions", "steward.md"), "utf8");
function tmp(t: T): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-steward-cmp-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function watch(cwd: string, over: Record<string, unknown> = {}, extra: Partial<StewardDeps> = {}) {
  const sent: string[] = [];
  const entries: StewardEntry[] = [];
  let tick: (() => void) | null = null;
  const deps: StewardDeps = {
    cwd: () => cwd,
    settings: () => stewardSettings({ steward: { enabled: true, ...over } }),
    now: () => Date.now(),
    timers: { set: (fn) => ((tick = fn), 1), clear: () => void (tick = null) },
    piSessionId: () => "pi-1",
    persist: (e) => void entries.push(e),
    sendText: (x) => void sent.push(x),
    sendWake: () => undefined,
    idle: () => true,
    instruction: () => INSTRUCTION,
    trace: () => undefined,
    notice: () => undefined,
    ...extra,
  };
  return { watch: new StewardWatch(deps), sent, entries, fire: () => tick?.(), armed: () => tick !== null };
}

for (const n of [1, 5]) {
  test(`resend after a compaction carries the configured limit ${n}`, (t) => {
    const r = watch(tmp(t), { maxProposals: n });
    r.watch.on();
    r.watch.resend();
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[1], r.sent[0]);
    assert.ok(r.sent[1].includes(`at most ${n} rounds`) && !r.sent[1].includes("{maxProposals}"));
  });
}

test("resend sends nothing when the watch is off", (t) => {
  const r = watch(tmp(t));
  r.watch.resend();
  assert.equal(r.sent.length, 0);
  r.watch.on();
  r.watch.off();
  r.watch.resend();
  assert.equal(r.sent.length, 1);
});

test("a resumed steward sends no second text, but a compaction after the resume sends it again", (t) => {
  const dir = tmp(t);
  const a = watch(dir);
  a.watch.on();
  a.watch.clear();
  const b = watch(dir);
  b.watch.restore(a.entries.map((data) => ({ type: "custom", customType: STEWARD_ENTRY, data })));
  assert.equal(b.watch.active, true);
  assert.equal(b.sent.length, 0);
  b.watch.resend();
  assert.equal(b.sent.length, 1);
});

test("a throwing settings read at arm time does not end the timer", (t) => {
  const dir = tmp(t);
  let boom = false;
  let sets = 0;
  const r = watch(dir, {}, {
    settings: () => { if (boom) throw new Error("settings"); return stewardSettings({ steward: { enabled: true } }); },
    timers: { set: () => ++sets, clear: () => undefined },
  });
  r.watch.on();
  assert.equal(sets, 1);
  boom = true;
  r.watch.tick();
  (r.watch as unknown as { arm(): void }).arm();
  assert.equal(sets, 2, "armed again although the settings read threw");
});

test("retroCounters drops the command words and file names of the session, keeps tool_usage names", () => {
  const out = JSON.parse(retroCounters(JSON.stringify({ usage: { n: 1 }, session_tools: { repeated_reads: { "x.ts": 3 } }, flagged_asks: { "git push": 1 }, tool_usage: { tools_never_used: ["foo"] }, proposals: [] }))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out).sort(), ["tool_usage", "usage"]);
});

type Res = { content: { text: string }[]; isError?: boolean };
async function adapterRig(t: T, child = false, config: Record<string, unknown> = { steward: { enabled: true } }) {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<Res> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: { customType: string; content: string }[] = [];
  const a = await r11Rig(t, { ledgerHelper: "tool" }, {
    child,
    config: { presence: { enabled: false }, ...config },
    ctx: { ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: { name: string; execute: never }) => void tools.set(d.name, d as never),
      registerCommand: (n: string, d: never) => void commands.set(n, d),
      sendMessage: (m: { customType: string; content: string }) => void sent.push(m),
      appendEntry: () => undefined,
    },
  });
  const call = async (name: string, params: Record<string, unknown>) => {
    const r = await tools.get(name)!.execute("id", params, undefined, undefined, a.ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  const texts = () => sent.filter((m) => m.customType === STEWARD_TEXT_TYPE).map((m) => m.content);
  return { a, call, texts, command: (args: string) => commands.get("foreman")!.handler(args, a.ctx) };
}

test("the adapter sends the filled-in text once per compaction of the steward session", async (t) => {
  const r = await adapterRig(t, false, { steward: { enabled: true, maxProposals: 5 } });
  await r.command("steward on");
  assert.equal(r.texts().length, 1);
  await r.a.compact();
  assert.equal(r.texts().length, 2);
  await r.a.compact();
  assert.equal(r.texts().length, 3);
  assert.ok(r.texts().every((x) => x.includes("at most 5 rounds")));
});

test("a compaction sends no steward text with the feature off or in a session that is not the steward", async (t) => {
  const off = await adapterRig(t, false, { steward: { enabled: false } });
  await off.a.compact();
  assert.equal(off.texts().length, 0);
  const plain = await adapterRig(t);
  await plain.a.compact();
  assert.equal(plain.texts().length, 0);
});

test("foreman_reports retro is refused outside the steward session, with the feature off and in a child", { skip }, async (t) => {
  for (const [child, config] of [[false, { steward: { enabled: true } }], [false, { steward: { enabled: false } }], [true, { steward: { enabled: true } }]] as const) {
    const r = await adapterRig(t, child, config);
    const out = await r.call("foreman_reports", { action: "retro" });
    assert.equal(out.isError, true);
    assert.match(out.text, child ? /foreman session only/ : /steward session only/);
  }
});

test("foreman_reports retro answers in the steward session without session_tools and flagged_asks", { skip }, async (t) => {
  const r = await adapterRig(t);
  await r.command("steward on");
  const out = await r.call("foreman_reports", { action: "retro" });
  assert.equal(out.isError, false, out.text);
  const j = JSON.parse(out.text) as Record<string, unknown>;
  assert.ok(!("session_tools" in j) && !("flagged_asks" in j) && !("proposals" in j));
});
