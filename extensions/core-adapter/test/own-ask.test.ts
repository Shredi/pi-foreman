// PR 3 of the intercom round: the one rule for a session's own `ask.md` (ownask.ts). Open = an `ask.md` in the own handoff dir newer than every
// answer file and not answered at the pane; open sets the parent blocked source and, once per version, `waitingForParent`. The real adapter over the r46 world.
// The cases share one world (each starts with `reset()`: the handoff files gone, the flag cleared, the counters read from zero, a later clock); the
// session-start and shim-off cases need a world of their own.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world, tick } from "./_r46world.ts";
import { WAKE_MESSAGE_TYPE } from "../usage.ts";
import { liveDir } from "../livestate.ts";
import { installBlockedShim } from "../herdr.ts";
import { OwnAsk } from "../ownask.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. done\n- [x] V. fresh-eyes verification passed\n";
const ASK = "# Ask 1: which one?\n\nA or B?\n";
type Rig = Awaited<ReturnType<typeof rig>>;
type R = { continue?: boolean } | undefined;

/** A file with its mtime set to `at` (ms epoch). */
const put = (file: string, text: string, at: number): void => {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, at / 1000, at / 1000);
};

async function rig(t: { after(fn: () => void | Promise<void>): void }, o: { shimOff?: boolean; ledger?: boolean } = {}) {
  const w = world(t, { ceremony: { default: "standard" }, handoff: true, parent: true });
  if (o.shimOff) {
    const f = path.join(w.handoff, "..", "..", "..", "foreman.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), herdr: { blockedShim: false } }));
  }
  const a = await w.adapter();
  if (o.ledger) await a.writeLedger(LEDGER);
  const clock = { base: Date.now() + 5_000 };
  let n = 0;
  const wrote = (file: string) => a.fire("tool_result", { toolName: "write", toolCallId: `w${++n}`, input: { path: file }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  const bash = () => a.fire("tool_result", { toolName: "bash", toolCallId: `b${++n}`, input: { command: "cp ask.md ." }, details: { exitCode: 0 }, content: [{ type: "text", text: "" }], isError: false });
  const message = (customType = "intercom_message") => a.fire("message_end", { message: { role: "custom", customType, details: { from: { id: "parent-session", name: "main" }, bodyText: "Answer: A", message: { content: { text: "**From main**\n\nAnswer: A" } } }, content: "Answer: A" } });
  const typed = () => a.fire("input", { source: "interactive", text: "go on" });
  const settle = async (): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
  const events = async (name: string) => (await w.traceEvents()).filter((e) => e.event === name);
  const total = {
    flag: async () => (await events("waiting_for_parent")).filter((e) => e.decision === "set" && e.toolFamily === "ask").length,
    open: async () => (await events("blocked_open")).filter((e) => e.on === "parent" && e.kind === "parent-ask").length,
    closed: async () => (await events("blocked_closed")).filter((e) => e.on === "parent" && e.kind === "parent-ask").length,
  };
  const zero = { flag: 0, open: 0, closed: 0 };
  // The counts since the last reset.
  const flagSets = async () => (await total.flag()) - zero.flag;
  const open = async () => (await total.open()) - zero.open;
  const closed = async () => (await total.closed()) - zero.closed;
  const ask = (at = clock.base) => put(path.join(w.handoff, "ask.md"), ASK, at);
  /** A clean start for the next case: the ask and answer files gone, the flag cleared, the counters at zero, the clock a minute on. */
  const reset = async (): Promise<void> => {
    for (const f of fs.readdirSync(w.handoff)) if (/^(ask|brief-.*|ruling(-.*)?|steer-.*)\.md$/.test(f)) fs.rmSync(path.join(w.handoff, f));
    await typed();
    await wrote(path.join(w.project, `case${++n}.txt`)); // a new state: the finish refusals (two per unchanged state) start again
    zero.flag = await total.flag();
    zero.open = await total.open();
    zero.closed = await total.closed();
    clock.base += 60_000;
  };
  return { w, a, clock, wrote, bash, message, typed, settle, events, flagSets, open, closed, ask, reset };
}

const held = async (r: Rig): Promise<boolean> => (await r.settle())?.continue === true;

test("the own ask.md: its blocked source, flag and answers (one world)", async (t) => {
  const r = await rig(t, { ledger: true });
  const askFile = path.join(r.w.handoff, "ask.md");
  const at = (ms: number): number => r.clock.base + ms;

  await t.test("a tool write of ask.md into the own handoff dir sets the parent blocked source; a write of another file does not", async () => {
    await r.reset();
    const notes = path.join(r.w.handoff, "notes.md");
    put(notes, "x", at(0));
    await r.wrote(notes);
    assert.equal(await r.open(), 0, "another file");
    r.ask(at(0));
    await r.wrote(askFile);
    assert.equal(await r.open(), 1);
    assert.equal((await r.events("blocked_open")).at(-1)?.label, "ask 1: which one?");
    assert.equal(await r.closed(), 0);
    fs.rmSync(notes);
  });

  await t.test("an ask.md written into another dir sets nothing", async () => {
    await r.reset();
    const other = path.join(path.dirname(r.w.handoff), "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    put(path.join(other, "ask.md"), ASK, at(0));
    await r.wrote(path.join(other, "ask.md"));
    assert.equal(await r.open(), 0);
    assert.equal(await r.flagSets(), 0);
    // nor does one in a subdirectory of the own dir
    fs.mkdirSync(path.join(r.w.handoff, "sub"), { recursive: true });
    put(path.join(r.w.handoff, "sub", "ask.md"), ASK, at(0));
    await r.wrote(path.join(r.w.handoff, "sub", "ask.md"));
    await r.bash();
    assert.equal(await r.open(), 0, "a subdirectory");
    fs.rmSync(path.join(r.w.handoff, "sub"), { recursive: true });
  });

  await t.test("an ask.md without the `# Ask <n>: <topic>` header is open too, under the plain label", async () => {
    await r.reset();
    put(askFile, "no header\n", at(0));
    await r.wrote(askFile);
    assert.equal(await r.open(), 1);
    assert.equal((await r.events("blocked_open")).at(-1)?.label, "ask");
  });

  await t.test("a brief written beside the ask clears it; so does typed input", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    assert.equal(await r.open(), 1);
    put(path.join(r.w.handoff, "brief-1.md"), "go with A", at(1000));
    await r.bash();
    assert.equal(await r.closed(), 1, "brief");
    // a second ask, answered at the pane
    r.ask(at(5000));
    await r.wrote(askFile);
    assert.equal(await r.open(), 2);
    await r.typed();
    assert.equal(await r.closed(), 2, "typed input");
  });

  await t.test("an ask.md copied in by a shell command sets mark and flag at that tool's result", async () => {
    await r.reset();
    r.ask(at(0));
    assert.equal(await r.open(), 0, "nothing before the result");
    await r.bash();
    assert.equal(await r.open(), 1);
    assert.equal(await r.flagSets(), 1);
    assert.equal(await r.settle(), undefined, "the turn ends without the finish checks");
  });

  await t.test("the same write sets waitingForParent once; a message, a wake or typed input clears it and it is not set again for that version", async () => {
    await r.reset();
    assert.equal(await held(r), true, "baseline: the finish checks hold");
    r.ask(at(0));
    await r.wrote(askFile);
    assert.equal(await r.flagSets(), 1);
    assert.equal(await r.settle(), undefined);
    for (const clear of [() => r.message(), () => r.message(WAKE_MESSAGE_TYPE), () => r.typed()]) {
      await clear();
      await r.bash();
      await r.wrote(askFile);
      assert.equal(await r.flagSets(), 1, "not set again for the same version");
    }
    assert.equal(await held(r), true, "the checks run again");
  });

  await t.test("a new ask.md version sets the flag again", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    await r.message();
    r.ask(at(3000));
    await r.wrote(askFile);
    assert.equal(await r.flagSets(), 2);
  });

  await t.test("typed input followed by a shell result leaves the mark off and the flag unset", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    await r.typed();
    const before = await r.flagSets();
    await r.bash();
    assert.equal(await r.open(), 1, "no second open");
    assert.equal(await r.closed(), 1);
    assert.equal(await r.flagSets(), before);
    assert.equal(await held(r), true);
  });

  await t.test("a wake that brings no answer file leaves the mark on", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    await r.message(WAKE_MESSAGE_TYPE);
    await r.message();
    assert.equal(await r.closed(), 0);
  });

  await t.test("a plan ruling, its brief copy or a steer after ask.md leaves the ask open", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    put(path.join(r.w.handoff, "ruling.md"), "APPROVED\n", at(1000));
    put(path.join(r.w.handoff, "ruling-plan.md"), "APPROVED\n", at(1000));
    put(path.join(r.w.handoff, "brief-1.md"), "APPROVED\n", at(1100));
    put(path.join(r.w.handoff, "steer-1.md"), "look at x", at(1200));
    await r.bash();
    await r.message(WAKE_MESSAGE_TYPE);
    assert.equal(await r.closed(), 0);
    put(path.join(r.w.handoff, "brief-2.md"), "go with A", at(2000));
    await r.bash();
    assert.equal(await r.closed(), 1, "a real brief clears it");
  });

  await t.test("a ruling-<n>.md from a parent on the old footer still answers the ask", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    put(path.join(r.w.handoff, "ruling-1.md"), "A", at(1000));
    await r.bash();
    assert.equal(await r.closed(), 1);
  });

  await t.test("no .ask or .seen is written anywhere", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    put(path.join(r.w.handoff, "ruling-1.md"), "A", at(1000));
    await r.bash();
    await r.a.fire("tool_result", { toolName: "read", toolCallId: "rd", input: { path: path.join(r.w.handoff, "ruling-1.md") }, details: {}, content: [{ type: "text", text: "A" }], isError: false });
    await r.message(WAKE_MESSAGE_TYPE);
    assert.deepEqual(fs.readdirSync(r.w.handoff).filter((n) => n === ".ask" || n === ".seen"), []);
  });

  await t.test("the mark is released at shutdown", async () => {
    await r.reset();
    r.ask(at(0));
    await r.wrote(askFile);
    assert.equal(await r.closed(), 0);
    await r.a.down();
    assert.equal(await r.closed(), 1);
  });
});

test("at session start an ask.md newer than every answer file sets mark and flag; an older one does not", async (t) => {
  const r = await rig(t);
  const base = r.clock.base;
  put(path.join(r.w.handoff, "brief-1.md"), "earlier answer", base);
  r.ask(base + 1000);
  const b = await r.w.adapter("startup");
  await tick(50);
  assert.equal(await r.open(), 1);
  assert.equal(await r.flagSets(), 1);
  await b.down();

  put(path.join(r.w.handoff, "brief-2.md"), "later answer", base + 9000);
  const open = await r.open();
  const flags = await r.flagSets();
  const c = await r.w.adapter("startup");
  await tick(50);
  assert.equal(await r.open(), open, "answered: no new open");
  assert.equal(await r.flagSets(), flags);
  await c.down();
});

test("presence carries it with the shim off; it is cleared by a brief and returns for the next ask", async (t) => {
  const r = await rig(t, { shimOff: true });
  const agentDir = path.resolve(r.w.handoff, "..", "..", "..");
  const file = path.join(liveDir(agentDir), `${path.basename(r.w.sessionFile, ".jsonl").replace(/^2026_/, "")}.json`);
  /** The live file once its presence is (or is not) needs-you; the file is written at most once a second. */
  const live = async (needsYou: boolean): Promise<Record<string, unknown>> => {
    let l: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      await tick(100);
      try {
        l = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if ((l.presence === "needs-you") === needsYou) break;
    }
    return l;
  };
  r.ask();
  await r.wrote(path.join(r.w.handoff, "ask.md"));
  const asked = await live(true);
  assert.equal(asked.presence, "needs-you");
  assert.equal(asked.blockedOn, "parent");
  put(path.join(r.w.handoff, "brief-1.md"), "go with A", r.clock.base + 1000);
  await r.bash();
  const answered = await live(false);
  assert.notEqual(answered.presence, "needs-you", "cleared by the brief");
  assert.equal(answered.blockedOn, undefined);
  r.ask(r.clock.base + 5000);
  await r.wrote(path.join(r.w.handoff, "ask.md"));
  const again = await live(true);
  assert.equal(again.presence, "needs-you", "returns for the next ask");
  assert.equal(again.blockedOn, "parent");
});

/** The live file once its presence is (or is not) needs-you; the file is written at most once a second. */
const liveFor = (r: Rig) => async (needsYou: boolean): Promise<Record<string, unknown>> => {
  const agentDir = path.resolve(r.w.handoff, "..", "..", "..");
  const file = path.join(liveDir(agentDir), `${path.basename(r.w.sessionFile, ".jsonl").replace(/^2026_/, "")}.json`);
  let l: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) {
    await tick(100);
    try {
      l = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if ((l.presence === "needs-you") === needsYou) break;
  }
  return l;
};

test("the live file keeps the open ask after the turn ended and after a later evaluation; a brief clears it", async (t) => {
  const r = await rig(t);
  const live = liveFor(r);
  r.ask();
  await r.wrote(path.join(r.w.handoff, "ask.md"));
  assert.equal((await live(true)).presence, "needs-you");
  await r.a.fire("agent_end", { messages: [] });
  const ended = await live(false);
  assert.equal(ended.presence, "needs-you", "the turn end does not release the own ask");
  assert.equal(ended.blockedOn, "parent");
  await r.bash();
  await r.message(WAKE_MESSAGE_TYPE);
  const later = await live(false);
  assert.equal(later.presence, "needs-you", "a later evaluation with no answer");
  assert.equal(later.blockedOn, "parent");
  put(path.join(r.w.handoff, "brief-1.md"), "go with A", r.clock.base + 1000);
  await r.bash();
  const answered = await live(false);
  assert.notEqual(answered.presence, "needs-you", "gone after a brief");
  assert.equal(answered.blockedOn, undefined);
});

test("the Herdr channel drops an own ask at agent_end and a later evaluation does not raise it again", async (t) => {
  const dir = mkTestTmp("pf-ownask-herdr-");
  t.after(() => rmTestTmp(dir));
  const sent: { active: boolean; label?: string }[] = [];
  const handlers = new Map<string, () => Promise<unknown>>();
  const events = { on: () => () => undefined, emit: (ch: string, d: unknown) => void (ch === "herdr:blocked" && sent.push(d as { active: boolean; label?: string })) };
  const pi = { events, on: (n: string, h: () => Promise<unknown>) => void handlers.set(n, h) };
  const tracker = installBlockedShim(pi as never, { env: { HERDR_ENV: "1" }, agentDir: dir });
  const handoff = path.join(dir, "handoff");
  fs.mkdirSync(handoff);
  const own = new OwnAsk({ dirs: () => [handoff], block: (label) => tracker.ownOn(label, { on: "parent", kind: "parent-ask" }) });
  put(path.join(handoff, "ask.md"), ASK, Date.now());
  assert.equal(own.evaluate().open, true);
  assert.deepEqual(sent, [{ active: true, label: "ask 1: which one?" }]);
  await handlers.get("agent_end")!();
  assert.deepEqual(sent.map((s) => s.active), [true, false], "the turn end releases the Herdr source");
  assert.equal(own.evaluate().open, true);
  assert.deepEqual(sent.map((s) => s.active), [true, false], "still open, not signalled again");
  put(path.join(handoff, "brief-1.md"), "go with A", Date.now() + 1000);
  assert.equal(own.evaluate().open, false);
  assert.deepEqual(sent.map((s) => s.active), [true, false], "the release after the clear sends nothing more");
});
