// The old `ask-after-plan-ruling` cases against the one rule for a session's own `ask.md` (ownask.ts): a plan ruling (`ruling.md`) never answers a
// question, an answered ask stays closed across a later plan ruling, an ask written after an answer is open again, and an answer older than the
// ask does not close it. The real adapter over the r46 world; the cases share it (each starts with `reset()`).
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world, tick } from "./_r46world.ts";
import { WAKE_MESSAGE_TYPE } from "../usage.ts";
import { liveDir } from "../livestate.ts";

const put = (file: string, text: string, at: number): void => {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, at / 1000, at / 1000);
};

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const w = world(t, { ceremony: { default: "standard" }, handoff: true, parent: true });
  const a = await w.adapter();
  const clock = { base: Date.now() + 5_000 };
  let n = 0;
  const file = (name: string): string => path.join(w.handoff, name);
  const bash = () => a.fire("tool_result", { toolName: "bash", toolCallId: `b${++n}`, input: { command: "ls" }, details: { exitCode: 0 }, content: [{ type: "text", text: "" }], isError: false });
  const wrote = (name: string) => a.fire("tool_result", { toolName: "write", toolCallId: `w${++n}`, input: { path: file(name) }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  const wake = () => a.fire("message_end", { message: { role: "custom", customType: WAKE_MESSAGE_TYPE, details: {}, content: "wake" } });
  const events = async (name: string) => (await w.traceEvents()).filter((e) => e.event === name && e.on === "parent" && e.kind === "parent-ask");
  const flags = async () => (await w.traceEvents()).filter((e) => e.event === "waiting_for_parent" && e.decision === "set" && e.toolFamily === "ask").length;
  const zero = { open: 0, closed: 0, flag: 0 };
  const at = (ms: number): number => clock.base + ms;
  const ask = async (when: number, k = 1): Promise<void> => {
    put(file("ask.md"), `# Ask ${k}: topic ${k}\n`, when);
    await wrote("ask.md");
  };
  const live = async (needsYou: boolean): Promise<Record<string, unknown>> => {
    const f = path.join(liveDir(path.resolve(w.handoff, "..", "..", "..")), `${path.basename(w.sessionFile, ".jsonl").replace(/^2026_/, "")}.json`);
    let l: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      await tick(100);
      try {
        l = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      if ((l.presence === "needs-you") === needsYou) break;
    }
    return l;
  };
  /** A clean start for the next case: the handoff files gone, the counters at zero, the clock a minute on. */
  const reset = async (): Promise<void> => {
    for (const f of fs.readdirSync(w.handoff)) if (/^(ask|brief-.*|ruling(-.*)?|steer-.*)\.md$/.test(f)) fs.rmSync(file(f));
    await bash();
    zero.open = (await events("blocked_open")).length;
    zero.closed = (await events("blocked_closed")).length;
    zero.flag = await flags();
    clock.base += 60_000;
  };
  return { file, bash, wake, ask, at, put, live, reset, opened: async () => (await events("blocked_open")).length - zero.open, closed: async () => (await events("blocked_closed")).length - zero.closed, flagged: async () => (await flags()) - zero.flag };
}

test("the plan ruling and the own ask.md (one world)", async (t) => {
  const r = await rig(t);

  await t.test("an ask.md written after a plan ruling is open", async () => {
    await r.reset();
    put(r.file("ruling.md"), "APPROVED\n", r.at(0));
    await r.ask(r.at(1000));
    assert.equal(await r.opened(), 1);
    await r.bash();
    assert.equal(await r.closed(), 0, "the plan ruling answers nothing");
  });

  await t.test("a second ask written after an answered first is open again", async () => {
    await r.reset();
    await r.ask(r.at(0));
    put(r.file("ruling-1.md"), "yes\n", r.at(1000));
    await r.bash();
    assert.equal(await r.closed(), 1);
    await r.ask(r.at(2000), 2);
    assert.equal(await r.opened(), 2);
    assert.equal(await r.closed(), 1);
  });

  await t.test("an answered ask stays closed after a later plan ruling", async () => {
    await r.reset();
    await r.ask(r.at(0));
    put(r.file("brief-1.md"), "go with A", r.at(1000));
    await r.bash();
    assert.equal(await r.closed(), 1);
    const opened = await r.opened();
    const flagged = await r.flagged();
    put(r.file("ruling.md"), "APPROVED\n", r.at(2000));
    put(r.file("ruling-plan.md"), "APPROVED\n", r.at(2000));
    await r.bash();
    await r.wake();
    await r.bash();
    assert.equal(await r.opened(), opened, "no reopen");
    assert.equal(await r.closed(), 1);
    assert.equal(await r.flagged(), flagged, "no new waiting-for-parent mark");
    const l = await r.live(false);
    assert.notEqual(l.presence, "needs-you", "not needs-you after the plan ruling");
    assert.equal(l.blockedOn, undefined, "no blocked source");
  });

  await t.test("an answer file older than ask.md does not close it; a newer one does", async () => {
    await r.reset();
    put(r.file("ruling-1.md"), "old\n", r.at(0));
    await r.ask(r.at(2000));
    await r.bash();
    assert.equal(await r.opened(), 1);
    assert.equal(await r.closed(), 0, "a stale ruling-<n>.md");
    put(r.file("ruling-1.md"), "new\n", r.at(3000));
    await r.bash();
    assert.equal(await r.closed(), 1);
    // no answer file at all: open again
    fs.rmSync(r.file("ruling-1.md"));
    await r.bash();
    assert.equal(await r.opened(), 2, "no answer file: open again");
  });

  await t.test("an answer file with the same mtime as ask.md closes it", async () => {
    await r.reset();
    await r.ask(r.at(2000));
    assert.equal(await r.opened(), 1);
    put(r.file("ruling-1.md"), "same\n", r.at(2000));
    await r.bash();
    assert.equal(await r.closed(), 1, "equal mtime counts as fresh");
  });
});
