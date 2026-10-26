// Slice 4b: the gate's ask routing per session kind (owner dialog, round ask.md + ruling, child and headless deny texts),
// and that a gate-decided call skips the old overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { parseAskHeader } from "../askcontract.ts";
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
const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const baseConfig = { providers: { fake: { review: { model: "m" }, roles: {} } } };

async function rig(t: Parameters<typeof r11Rig>[0], replies: Reply[], o: { answers?: (string | undefined)[]; typed?: string; child?: boolean; headless?: boolean; found?: boolean; gate?: Record<string, unknown> } = {}) {
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
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry, ui, ...(o.headless ? { hasUI: false, mode: "print" } : {}) }, config: { ...baseConfig, ...(o.gate ? { gate: o.gate } : {}) }, child: o.child });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { ...r, reg, titles, optionLists, log };
}

const ASK = V("ask", "package-install");
const CMD = { command: "pip install requests" };

test("owner ask: the dialog names the entry, shows the command and offers exactly four options; allow once continues", async (t) => {
  const r = await rig(t, [ASK], { answers: ["allow once"] });
  assert.equal(await r.call("bash", CMD), undefined);
  assert.deepEqual(r.optionLists[0], ["allow once", "allow for session", "deny with reason", "deny and stop"]);
  assert.match(r.titles[0], /policy asks \(package-install\)/);
  assert.match(r.titles[0], /pip install requests/);
  assert.match(r.titles[0], /because package-install/);
  const d = r.events("dialog").at(-1)!;
  assert.deepEqual([d.guard, d.cause, d.decision], ["gate", "ask", "allow once"]);
  assert.deepEqual([r.log().at(-1)!.layer, r.log().at(-1)!.verdict], ["dialog", "allow"]);
});

test("allow for session: the same call asks no more and costs no second model call; another command still asks", async (t) => {
  const r = await rig(t, [ASK], { answers: ["allow for session", "deny and stop"] });
  assert.equal(await r.call("bash", CMD), undefined);
  assert.equal(await r.call("bash", CMD), undefined);
  assert.equal(r.titles.length, 1);
  assert.equal(r.reg.calls.length, 1);
  const res = await r.call("bash", { command: "pip install flask" });
  assert.ok(res && res.block);
  assert.equal(r.titles.length, 2);
});

test("deny with reason: typed text goes to the agent; an empty text is a plain user deny", async (t) => {
  const r = await rig(t, [ASK], { answers: ["deny with reason"], typed: "not on this machine" });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.equal(res.reason, "pi-foreman: denied by the user: not on this machine");
  const plain = await rig(t, [ASK], { answers: ["deny with reason"], typed: "" });
  const res2 = await plain.call("bash", CMD);
  assert.equal(res2?.reason, "pi-foreman: denied by the user.");
});

test("deny and stop blocks every later reviewed call until the next user prompt", async (t) => {
  const r = await rig(t, [ASK, V("allow", "build-test-in-worktree")], { answers: ["deny and stop"] });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.match(String(res.reason), /stop and ask the owner/);
  const next = await r.call("bash", { command: "terraform plan" });
  assert.ok(next && next.block);
  assert.equal(next.reason, res.reason);
  assert.equal(r.reg.calls.length, 1);
  await r.ownerPrompt("continue please");
  assert.equal(await r.call("bash", { command: "terraform plan" }), undefined);
});

test("a dismissed dialog is a deny", async (t) => {
  const r = await rig(t, [ASK], { answers: [undefined] });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.match(String(res.reason), /denied by the user: the dialog was dismissed/);
  assert.equal(r.events("dialog").at(-1)!.decision, "dismissed");
});

test("owner unreachable: the dialog title names the cause for timeout-like provider errors and for no model", async (t) => {
  const r = await rig(t, [new Error("boom")], { answers: ["allow once"] });
  assert.equal(await r.call("bash", { command: "terraform plan" }), undefined);
  assert.match(r.titles[0], /review unreachable \(provider error\)/);
  assert.equal(r.events("dialog").at(-1)!.cause, "unreachable");
  const none = await rig(t, [V("allow", "x")], { answers: [undefined], found: false });
  const res = await none.call("bash", { command: "terraform plan" });
  assert.ok(res && res.block);
  assert.match(none.titles[0], /review unreachable \(no model configured\)/);
});

test("a long command is cut in the dialog", async (t) => {
  const r = await rig(t, [ASK], { answers: ["allow once"] });
  await r.call("bash", { command: `pip install ${"x".repeat(2000)}` });
  assert.ok(r.titles[0].length < 1000);
  assert.match(r.titles[0], /more chars/);
});

test("child and headless sessions deny with a text that says what to report; no dialog opens", async (t) => {
  const child = await rig(t, [ASK], { child: true, answers: ["allow once"] });
  const c = await child.call("bash", CMD);
  assert.equal(c?.reason, "pi-foreman: policy ask package-install: because package-install. Children cannot answer asks; report this line to the foreman and continue with what you can.");
  assert.equal(child.titles.length, 0);
  const cu = await rig(t, [new Error("boom")], { child: true });
  assert.match(String((await cu.call("bash", { command: "terraform plan" }))?.reason), /^pi-foreman: the permission review is unreachable \(provider error: .*\); the call is denied\. Report this to the owner\.$/);
  const head = await rig(t, [ASK], { headless: true, answers: ["allow once"] });
  const h = await head.call("bash", CMD);
  assert.ok(h && h.block);
  assert.match(String(h.reason), /Report this to the owner\.$/);
  assert.equal(head.titles.length, 0);
});

test("a gate-decided call skips the old overlay: one model call and no overlay trace record", async (t) => {
  const r = await rig(t, [V("allow", "build-test-in-worktree")]);
  assert.equal(await r.call("bash", { command: "terraform plan" }), undefined);
  assert.equal(r.reg.calls.length, 1);
  assert.equal(r.events("overlay").length, 0);
  const a = await rig(t, [ASK], { answers: ["allow once"] });
  await a.call("bash", CMD);
  assert.equal(a.reg.calls.length, 1);
  assert.equal(a.events("overlay").length, 0);
});

test("dialogReport counts the gate dialog records", async (t) => {
  const r = await rig(t, [ASK], { answers: ["allow once", "deny and stop"] });
  await r.call("bash", CMD);
  await r.ownerPrompt("x");
  await r.call("bash", { command: "pip install flask" });
  const dir = path.join(r.agentDir, "pi-foreman", "state");
  const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"))!;
  const rep = dialogReport(path.join(dir, f));
  const n = Object.values(rep).reduce((s, v) => s + v.count, 0);
  assert.equal(n, 2);
});

// ------------------------------------------------------------------ round sessions

async function roundRig(t: Parameters<typeof r11Rig>[0], replies: Reply[], gate?: Record<string, unknown>) {
  const r = await rig(t, replies, gate ? { gate } : {});
  const dir = path.join(r.agentDir, "round-handoff");
  fs.mkdirSync(dir, { recursive: true });
  const prev = process.env.PI_FOREMAN_HANDOFF_DIR;
  process.env.PI_FOREMAN_HANDOFF_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
    else process.env.PI_FOREMAN_HANDOFF_DIR = prev;
  });
  const askFile = path.join(dir, "ask.md");
  const waitAsk = async (): Promise<string> => {
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(askFile)) return fs.readFileSync(askFile, "utf8");
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("no ask.md");
  };
  return { ...r, dir, waitAsk };
}

test("round session: ask.md has a parseable header and a ruling ALLOW (any case) continues", async (t) => {
  const r = await roundRig(t, [ASK]);
  const p = r.call("bash", CMD);
  const text = await r.waitAsk();
  const head = parseAskHeader(text);
  assert.equal(head?.n, 1);
  assert.match(text, /entry: package-install/);
  assert.match(text, /pip install requests/);
  assert.match(text, new RegExp(`session: ${r.sessionId}`));
  fs.writeFileSync(path.join(r.dir, "ruling-1.md"), "allow\nfine\n");
  assert.equal(await p, undefined);
  assert.equal(r.titles.length, 0);
  assert.equal(r.events("dialog").at(-1)!.decision, "ruling-allow");
  assert.equal(r.log().at(-1)!.kind, "round");
});

test("round session: ruling DENY, a foreign first line and a timeout all deny; the next ask is number 2", async (t) => {
  const r = await roundRig(t, [ASK]);
  const p = r.call("bash", CMD);
  await r.waitAsk();
  fs.writeFileSync(path.join(r.dir, "ruling-1.md"), "DENY\n");
  const res = await p;
  assert.ok(res && res.block);
  assert.match(String(res.reason), /ruling-1\.md/);
  const p2 = r.call("bash", { command: "pip install flask" });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(r.dir, "ask.md")) ; i++) await new Promise((x) => setTimeout(x, 10));
  for (let i = 0; i < 200 && parseAskHeader(fs.readFileSync(path.join(r.dir, "ask.md"), "utf8"))?.n !== 2; i++) await new Promise((x) => setTimeout(x, 10));
  fs.writeFileSync(path.join(r.dir, "ruling-2.md"), "maybe\n");
  const res2 = await p2;
  assert.match(String(res2?.reason), /not ALLOW or DENY/);
  assert.equal(r.events("dialog").at(-1)!.decision, "ruling-deny");
});

test("round session: no ruling within gate.askTimeoutMs denies", async (t) => {
  const r = await roundRig(t, [ASK], { askTimeoutMs: 60 });
  const res = await r.call("bash", CMD);
  assert.ok(res && res.block);
  assert.match(String(res.reason), /no ruling-1\.md within/);
  assert.equal(r.events("dialog").at(-1)!.decision, "timeout");
});
