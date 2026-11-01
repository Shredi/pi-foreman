// r79 items 5, 6, 10, 11: the gate's ask routing per session kind: the owner dialog (four options), the deny texts of a child and a headless session.
// The "allow for session" option and the round-session ask.md routing are gone; a session opened by another session asks in its own pane.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { dialogReport } from "../dialogs.ts";

type Reply = string | Error;
function fakeRegistry(replies: Reply[], found = true) {
  const calls: { text: string }[] = [];
  const registry = {
    find: () => (found ? { id: "m" } : undefined),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push({ text: ctx.messages[0].content });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}
const ESCALATE = JSON.stringify({ verdict: "escalate", entry: null, reason: "unsure" });
// presence off: an owner dialog in a rig awaits the presence probe otherwise
const baseConfig = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: {} } } };

async function rig(t: Parameters<typeof r11Rig>[0], replies: Reply[], o: { answers?: (string | undefined)[]; typed?: string; child?: boolean; headless?: boolean; found?: boolean } = {}) {
  const reg = fakeRegistry(replies, o.found ?? true);
  const titles: string[] = [];
  const optionLists: string[][] = [];
  const answers = [...(o.answers ?? [])];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: async (title: string, options: string[]) => (titles.push(title), optionLists.push(options), answers.shift()),
    input: async () => o.typed,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry, ui, ...(o.headless ? { hasUI: false, mode: "print" } : {}) }, config: baseConfig, child: o.child });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { ...r, reg, titles, optionLists, log };
}

const CMD = { command: "pip install requests" };

test("owner ask: the dialog shows the cause and the command and offers the four options; allow once continues", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: ["allow once"] });
  assert.equal(await r.call("bash", CMD), undefined);
  assert.deepEqual(r.optionLists[0], ["allow once", "allow and remember", "deny with comment", "deny and stop"]);
  assert.match(r.titles[0], /^pi-foreman: bash asks\n/);
  assert.match(r.titles[0], /cause: danger-install/);
  assert.match(r.titles[0], /pip install requests/);
  const d = r.events("dialog").at(-1)!;
  assert.deepEqual([d.guard, d.cause, d.kind, d.decision], ["gate", "danger", "owner", "allow-once"]);
  assert.deepEqual([r.log().at(-1)!.layer, r.log().at(-1)!.verdict], ["dialog", "allow"]);
});

test("deny with comment: typed text goes to the agent; an empty text is a plain user deny", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: ["deny with comment"], typed: "not on this machine" });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.equal(res.reason, "pi-foreman: denied by the user: not on this machine");
  const plain = await rig(t, [ESCALATE], { answers: ["deny with comment"], typed: "" });
  assert.equal((await plain.call("bash", CMD))?.reason, "pi-foreman: denied by the user.");
});

test("deny and stop blocks every later gated call until the next user prompt", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: ["deny and stop"] });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.match(String(res.reason), /stop and ask the owner/);
  const next = await r.call("bash", { command: "terraform plan" });
  assert.ok(next && next.block);
  assert.equal(next.reason, res.reason);
  await r.ownerPrompt("continue please");
  assert.equal(await r.call("bash", { command: "terraform plan" }), undefined);
});

test("a dismissed dialog is a deny", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: [undefined] });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.match(String(res.reason), /denied by the user: the dialog was dismissed/);
  assert.equal(r.events("dialog").at(-1)!.decision, "dismissed");
});

test("a command of many lines is cut in the dialog and the full text goes to a file", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: ["allow once"] });
  await r.call("bash", { command: `pip install x\n${Array.from({ length: 200 }, (_, i) => `echo line${i}`).join("\n")}` });
  assert.match(r.titles[0], /lines omitted/);
  assert.ok(r.titles[0].split("\n").length < 100);
});

test("child and headless sessions deny with the no-pane text; no dialog opens", async (t) => {
  const child = await rig(t, [ESCALATE], { child: true, answers: ["allow once"] });
  const c = await child.call("bash", CMD);
  assert.match(String(c?.reason), /^pi-foreman: denied: nobody is at this session \(no pane\)/);
  assert.equal(child.titles.length, 0);
  const head = await rig(t, [ESCALATE], { headless: true, answers: ["allow once"] });
  const h = await head.call("bash", CMD);
  assert.ok(h && h.block);
  assert.match(String(h.reason), /nobody is at this session/);
  assert.equal(head.titles.length, 0);
});

test("dialogReport counts the gate dialog records", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: ["allow once", "deny and stop"] });
  await r.call("bash", CMD);
  await r.ownerPrompt("x");
  await r.call("bash", { command: "pip install flask" });
  const dir = path.join(r.agentDir, "pi-foreman", "state");
  const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"))!;
  const rep = dialogReport(path.join(dir, f));
  assert.equal(Object.values(rep).reduce((s, v) => s + v.count, 0), 2);
});

test("every gate record has its own unique id, the dialog record included", async (t) => {
  const r = await rig(t, [ESCALATE], { answers: ["allow once", "deny and stop"] });
  await r.call("bash", CMD);
  await r.call("bash", { command: "pip install flask" });
  const recs = r.log();
  assert.ok(recs.some((x) => x.layer === "dialog"));
  for (const x of recs) assert.match(String(x.id), /^[0-9a-f]{12}$/);
  assert.equal(new Set(recs.map((x) => x.id)).size, recs.length, "ids are unique");
});

// selfmod rules (selfmod.ts): one rig case per session kind
const SETTINGS = { path: ".pi/settings.json", content: "{}" };

test("selfmod rule, owner: the dialog names the cause selfmod; no classifier call; allow once continues", async (t) => {
  const r = await rig(t, [], { answers: ["allow once"] });
  // the gate lets it through; the foreman's scratchpad guard (a later handler) still refuses the write
  assert.doesNotMatch(String((await r.call("write", SETTINGS))?.reason), /self-modification/);
  assert.equal(r.titles.length, 1);
  assert.match(r.titles[0], /cause: .*selfmod-project-settings/);
  assert.equal(r.optionLists[0].includes("allow and remember"), false, "no remember for a selfmod ask");
  assert.equal(r.reg.calls.length, 0);
  const d = r.events("dialog").at(-1)!;
  assert.deepEqual([d.rule, d.decision], ["self-modification", "allow-once"]);
});

test("selfmod rule, child and headless: a deny that says nobody is at the session; no dialog", async (t) => {
  const child = await rig(t, [], { child: true, answers: ["allow once"] });
  assert.match(String((await child.call("write", SETTINGS))?.reason), /selfmod-project-settings|nobody is at this session/);
  const head = await rig(t, [], { headless: true, answers: ["allow once"] });
  assert.match(String((await head.call("write", SETTINGS))?.reason), /selfmod-project-settings|nobody is at this session/);
  assert.equal(child.titles.length + head.titles.length, 0);
});
