// r79 items 5, 10, 11: a child's ask is written as ask.md with the cause (danger-<name>, rule, selfmod) and answered by the owner pane of the parent;
// a session opened by another session asks in its own pane. Plan Addendum 5: a child's policy ask goes to the parent (ask dir in the launch binding, ask.md / ruling-<n>.md), the parent
// side (owner dialog, round forward, queue, lateness), the floor on the ask tree and the stale-ruling rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { shPath } from "./_shpath.ts";
import { gateLogFile } from "../gatelog.ts";
import { awaitChildRuling as awaitRuling, childAskDir, ChildAskWatch, writeChildAsk } from "../childask.ts";
import { SteerWatch } from "../steerwatch.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const ROLES = ["explorer", "builder", "reviewer"];
const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const ASK = V("ask", "package-install");
// the ask file as the gate writes it (r79 item 5): a cause line and a reason line
const writeRoundAsk = (dir: string, a: { cause: string; entry: string; reason: string }, f: Omit<Parameters<typeof writeChildAsk>[1], "cause" | "reason" | "entry">): number => writeChildAsk(dir, { ...f, cause: a.cause, reason: a.reason, entry: a.entry });
const CMD = { command: "pip install requests" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}

function registry(reply: string) {
  return { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
}
const config = (gate?: Record<string, unknown>) => ({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } }, ...(gate ? { gate } : {}), presence: { enabled: false } });
const logOf = (agentDir: string): Record<string, unknown>[] => {
  const f = gateLogFile(agentDir);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const bound = (input: Record<string, unknown>) => (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
const ASK_FIELDS = { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", run: "L9" };

/** A parent session (owner pane; round with `handoff`): select answers come from `answers`, or from `pending` when `hold`. */
async function parentRig(t: T, o: { gate?: Record<string, unknown>; headless?: boolean; answers?: (string | undefined)[]; typed?: string; hold?: boolean; handoff?: boolean } = {}) {
  const titles: string[] = [];
  const answers = [...(o.answers ?? [])];
  const pending: ((v: string) => void)[] = [];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: (title: string) => {
      titles.push(title);
      return o.hold ? new Promise<string>((res) => pending.push(res)) : Promise.resolve(answers.shift());
    },
    input: async () => o.typed,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry(V("allow", "read-only-inspection")), ...(o.headless ? { hasUI: false, mode: "print" } : {}) }, config: config(o.gate) });
  let handoff: string | undefined;
  if (o.handoff) {
    handoff = path.join(r.agentDir, "round-handoff");
    fs.mkdirSync(handoff, { recursive: true });
    const prev = process.env.PI_FOREMAN_HANDOFF_DIR;
    process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
    t.after(() => {
      if (prev === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
      else process.env.PI_FOREMAN_HANDOFF_DIR = prev;
    });
  }
  const launch = async () => {
    const input: Record<string, unknown> = { agent: "builder", task: "go" };
    const out = await r.launch(input);
    return { ...out, input, askDir: bound(input)?.askDir as string | undefined };
  };
  return { ...r, titles, pending, handoff, launch };
}

/** A child session whose binding names `askDir` (null = no ask dir); the review answers `reply`. */
async function childRig(t: T, askDir: string | null, reply: string, gate?: Record<string, unknown>) {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, ...(askDir ? { askDir } : {}) } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  return r11Rig(t, {}, { ctx: { modelRegistry: registry(reply) }, config: config(gate), child: true });
}
const tmpAskDir = (t: T): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-child-ask-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// ------------------------------------------------------------------ binding and parent side

test("the launch binding carries askDir under state/child-asks/<parent>/<launch>; the dir exists", async (t) => {
  const r = await parentRig(t);
  const { askDir, input } = await r.launch();
  assert.ok(askDir);
  assert.equal(askDir, childAskDir(r.agentDir, r.sessionId, String(bound(input).launchId)));
  assert.ok(askDir.startsWith(path.join(r.agentDir, "pi-foreman", "state", "child-asks", r.sessionId) + path.sep));
  assert.ok(fs.statSync(askDir).isDirectory());
});

test("no askDir for a headless parent or with gate.childAsk deny", async (t) => {
  const head = await parentRig(t, { headless: true });
  assert.equal((await head.launch()).askDir, undefined);
  const deny = await parentRig(t, { gate: { childAsk: "deny" } });
  assert.equal((await deny.launch()).askDir, undefined);
});

test("owner parent: one dialog names the child role and run; allow once writes ruling-1.md ALLOW; the parent logs a child-ask record", async (t) => {
  const r = await parentRig(t, { answers: ["allow once"] });
  const { askDir } = await r.launch();
  const n = writeRoundAsk(askDir!, { cause: "ask", entry: "package-install", reason: "because" }, ASK_FIELDS);
  const ruling = path.join(askDir!, `ruling-${n}.md`);
  await until(() => fs.existsSync(ruling));
  assert.equal(fs.readFileSync(ruling, "utf8").split("\n")[0], "ALLOW");
  assert.match(r.titles[0], /from the builder \(run L9\)/);
  assert.match(r.titles[0], /pip install requests/);
  const rec = await until(() => logOf(r.agentDir).find((x) => x.layer === "child-ask"));
  assert.deepEqual([rec.verdict, rec.rule], ["allow", "package-install"]);
  assert.match(String(rec.reason), /child run L9/);
});

test("owner parent: deny with reason writes DENY and the reason; a dismissed dialog denies", async (t) => {
  const r = await parentRig(t, { answers: ["deny with comment", undefined], typed: "not this one" });
  const { askDir } = await r.launch();
  writeRoundAsk(askDir!, { cause: "ask", entry: "e", reason: "r" }, ASK_FIELDS);
  const f1 = path.join(askDir!, "ruling-1.md");
  await until(() => fs.existsSync(f1));
  assert.equal(fs.readFileSync(f1, "utf8"), "DENY\npi-foreman: denied by the user: not this one\n");
  writeRoundAsk(askDir!, { cause: "ask", entry: "e", reason: "r" }, ASK_FIELDS);
  const f2 = path.join(askDir!, "ruling-2.md");
  await until(() => fs.existsSync(f2));
  assert.match(fs.readFileSync(f2, "utf8"), /^DENY\npi-foreman: denied by the user: the dialog was dismissed/);
});

test("two children's asks queue: one dialog at a time", async (t) => {
  const r = await parentRig(t, { hold: true });
  const a = await r.launch();
  const b = await r.launch();
  writeRoundAsk(a.askDir!, { cause: "ask", entry: "e", reason: "r" }, { ...ASK_FIELDS, run: "A" });
  writeRoundAsk(b.askDir!, { cause: "ask", entry: "e", reason: "r" }, { ...ASK_FIELDS, run: "B" });
  await until(() => r.pending.length === 1);
  await sleep(1200); // two more polls: the second ask stays queued
  assert.equal(r.titles.length, 1);
  r.pending[0]("allow once");
  await until(() => r.pending.length === 2);
  assert.equal(r.titles.length, 2);
  assert.notEqual(r.titles[0], r.titles[1]);
  r.pending[1]("allow once");
  await until(() => fs.existsSync(path.join(a.askDir!, "ruling-1.md")) && fs.existsSync(path.join(b.askDir!, "ruling-1.md")));
});

test("an ask past its deadline is dropped; an answer after the deadline is logged late and never written", async (t) => {
  const r = await parentRig(t, { hold: true });
  const { askDir } = await r.launch();
  writeRoundAsk(askDir!, { cause: "ask", entry: "e", reason: "r" }, { ...ASK_FIELDS, deadline: Date.now() - 1000 });
  await sleep(1200);
  assert.equal(r.titles.length, 0, "expired: no dialog");
  assert.ok(logOf(r.agentDir).some((x) => x.layer === "child-ask" && /expired/.test(String(x.reason))));
  writeRoundAsk(askDir!, { cause: "ask", entry: "e", reason: "r" }, { ...ASK_FIELDS, deadline: Date.now() + 700 });
  await until(() => r.pending.length === 1);
  await sleep(900);
  r.pending[0]("allow once");
  await until(() => logOf(r.agentDir).some((x) => x.layer === "child-ask" && /late/.test(String(x.reason))));
  assert.equal(fs.existsSync(path.join(askDir!, "ruling-2.md")), false);
});

test("run end removes the ask dir", async (t) => {
  const r = await parentRig(t);
  const { askDir, id, input } = await r.launch();
  await r.started(id, input, "run-1");
  assert.ok(fs.existsSync(askDir!));
  r.end({ runId: "run-1" });
  await until(() => !fs.existsSync(askDir!));
});

// r79 item 5: the round-ask forward is gone; a session opened by another session asks in its own pane, and never writes into its handoff dir
test("a session opened by another session asks its child's ask in its own pane", async (t) => {
  const r = await parentRig(t, { handoff: true, answers: ["allow once"] });
  const { askDir } = await r.launch();
  writeRoundAsk(askDir!, { cause: "ask", entry: "package-install", reason: "because" }, ASK_FIELDS);
  const down = path.join(askDir!, "ruling-1.md");
  await until(() => fs.existsSync(down));
  assert.equal(fs.readFileSync(down, "utf8").split("\n")[0], "ALLOW");
  assert.equal(r.titles.length, 1, "one dialog in its own pane");
  assert.equal(fs.existsSync(path.join(r.handoff!, "ask.md")), false);
});

test("steerwatch does not deliver a ruling the child-ask forward consumed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-steer-skip-"));
  try {
    const w = new SteerWatch(() => dir, 0);
    w.baseline();
    fs.writeFileSync(path.join(dir, "ruling-1.md"), "ALLOW\n");
    w.skip("ruling-1.md");
    assert.equal(w.take(), "");
    fs.writeFileSync(path.join(dir, "ruling-2.md"), "ALLOW\n");
    assert.match(w.take(), /ruling-2\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a headless watch answer failing denies; an unreadable answer never allows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-watch-"));
  try {
    const events: string[] = [];
    const w = new ChildAskWatch(async () => { throw new Error("boom"); }, (e) => events.push(e.kind), { set: () => 1, clear: () => undefined });
    w.add(dir);
    writeRoundAsk(dir, { cause: "ask", entry: "e", reason: "r" }, ASK_FIELDS);
    w.poll();
    await until(() => events.length > 0);
    assert.equal(fs.readFileSync(path.join(dir, "ruling-1.md"), "utf8").split("\n")[0], "DENY");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ child side

test("child ask: ask.md carries role and run; an ALLOW ruling lets the call run and logs parent-allow", async (t) => {
  const dir = tmpAskDir(t);
  const r = await childRig(t, dir, ASK);
  const p = r.call("bash", CMD);
  const text = await until(() => (fs.existsSync(path.join(dir, "ask.md")) ? fs.readFileSync(path.join(dir, "ask.md"), "utf8") : false));
  assert.match(text, /^# Ask 1: /);
  assert.match(text, /cause: danger-install/);
  assert.match(text, /role: builder/);
  assert.match(text, /run: L9/);
  assert.match(text, /deadline: \d+/);
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "ALLOW\n");
  assert.equal(await p, undefined);
  const d = r.events("dialog").at(-1)!;
  assert.deepEqual([d.cause, d.kind, d.decision], ["danger", "child", "parent-allow"]);
  const rec = logOf(r.agentDir).filter((x) => x.layer === "dialog").at(-1)!;
  assert.deepEqual([rec.verdict, rec.rule === "danger-install" && rec.kind, rec.kind], ["allow", "child", "child"]);
});

test("child ask: DENY blocks with the parent's reason (parent-deny); a foreign first line denies", async (t) => {
  const dir = tmpAskDir(t);
  const r = await childRig(t, dir, ASK);
  const p = r.call("bash", CMD);
  await until(() => fs.existsSync(path.join(dir, "ask.md")));
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "DENY\nnot this one\n");
  const res = await p;
  assert.ok(res?.block);
  assert.match(String(res.reason), /denied by the parent: not this one/);
  assert.equal(r.events("dialog").at(-1)!.decision, "parent-deny");
  const p2 = r.call("bash", { command: "pip install flask" });
  await until(() => /^# Ask 2: /.test(fs.readFileSync(path.join(dir, "ask.md"), "utf8")));
  fs.writeFileSync(path.join(dir, "ruling-2.md"), "maybe\n");
  assert.match(String((await p2)?.reason), /not ALLOW or DENY/);
});

test("child ask: no ruling within gate.askTimeoutMs denies with parent-timeout", async (t) => {
  const dir = tmpAskDir(t);
  const r = await childRig(t, dir, ASK, { askTimeoutMs: 80 });
  const res = await r.call("bash", CMD);
  assert.ok(res?.block);
  assert.match(String(res.reason), /the parent did not answer within \d+s \(gate\.askTimeoutMs\)/);
  assert.equal(r.events("dialog").at(-1)!.decision, "parent-timeout");
});

test("child ask: an unusable classifier reply escalates, so the ask is written for the parent", async (t) => {
  const dir = tmpAskDir(t);
  const r = await childRig(t, dir, "this is not json");
  const p = r.call("bash", CMD);
  const text = await until(() => (fs.existsSync(path.join(dir, "ask.md")) ? fs.readFileSync(path.join(dir, "ask.md"), "utf8") : false));
  assert.match(text, /cause: danger-install/);
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "DENY\n");
  assert.ok((await p)?.block);
});

test("child ask: gate.childAsk deny, or no askDir in the binding, denies with the no-pane text and writes no ask", async (t) => {
  const text = /^pi-foreman: denied: nobody is at this session \(no pane\)\..*The call was: danger-install/;
  const dir = tmpAskDir(t);
  const denied = await childRig(t, dir, ASK, { childAsk: "deny" });
  assert.match(String((await denied.call("bash", CMD))?.reason), text);
  assert.equal(fs.existsSync(path.join(dir, "ask.md")), false);
  const none = await childRig(t, null, ASK);
  assert.match(String((await none.call("bash", CMD))?.reason), text);
});

test("a stale ruling (mtime before its ask) is ignored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-stale-"));
  try {
    const f = path.join(dir, "ruling-1.md");
    fs.writeFileSync(f, "ALLOW\n");
    fs.utimesSync(f, 1000, 1000);
    assert.equal((await awaitRuling(dir, 1, 80, 10, Date.now() - 1000)).answer, "timeout");
    assert.equal((await awaitRuling(dir, 1, 80, 10, 0)).answer, "allow");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("floors: a child's tool writes under state/child-asks (write, edit, shell redirect) are denied, so it never writes its own ruling", async (t) => {
  // one rig per call: the same refusal twice in a run stops the run (repeated-deny), which is not what this test pins
  const refused = async (call: (agentDir: string) => [string, Record<string, unknown>]): Promise<string> => {
    const r = await childRig(t, null, ASK);
    const [tool, input] = call(path.join(r.agentDir, "pi-foreman", "state", "child-asks", "parent-s", "L9"));
    return String((await r.call(tool, input))?.reason);
  };
  assert.match(await refused((b) => ["write", { path: path.join(b, "ruling-1.md"), content: "ALLOW\n" }]), /^pi-foreman: denied by the permission floor \(policy-file\)/);
  assert.match(await refused((b) => ["edit", { path: path.join(b, "ruling-2.md"), edits: [{ oldText: "a", newText: "b" }] }]), /^pi-foreman: denied by the permission floor \(policy-file\)/);
  assert.match(await refused((b) => ["bash", { command: `echo ALLOW > ${shPath(path.join(b, "ruling-3.md"))}` }]), /^pi-foreman: denied by the permission floor/);
  assert.match(await refused((b) => ["bash", { command: `cp /tmp/x ${shPath(path.join(b, "ruling-4.md"))}` }]), /^pi-foreman: denied by the permission floor/);
  assert.match(await refused((b) => ["write", { path: path.join(b, "ask.md"), content: "# Ask 9: x\n" }]), /^pi-foreman: denied by the permission floor \(policy-file\)/);
});
