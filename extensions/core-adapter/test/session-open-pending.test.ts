// foreman_session_open: pending owner confirmation, late answers by wake, withdrawal on abort, names of live sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NO_UI_REFUSAL, ownerConfirm, readRegistry, registryFile } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { applyInbound, parseInbound } from "../session.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers } from "../wait.ts";
import { rig, settlesWithin, sleep } from "./_session-open-rig.ts";
import type { SpawnResult } from "../spawn.ts";

const ok = (): SpawnResult => ({ code: 0, stdout: "opened in Herdr: tab t9", stderr: "", timedOut: false });

const tmpDir = (): string => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-open-handoff-")));

test("pending: no answer inside the window returns pending (not an error), spawns nothing, keeps the dialog", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const res = await r.call({});
    assert.equal(res.details.decision, "pending");
    assert.equal(res.isError, undefined);
    assert.match(r.text(res), /pending owner confirmation/);
    assert.equal(r.spawned.length, 0);
    assert.equal(r.dialogs.length, 1);
    assert.equal(r.dialogs[0].signal?.aborted, false, "the dialog stays");
    r.dialogs[0].answer(false);
    await sleep(20);
  } finally {
    r.cleanup();
  }
});

test("pending: a repeated open for the label answers pending without a second dialog; other labels are not queued behind it", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    await r.call({});
    const again = await r.call({});
    assert.equal(again.details.decision, "pending");
    assert.equal(r.dialogs.length, 1, "no second dialog for the same label");
    const other = r.call({ label: "other" });
    await sleep(20);
    assert.equal(r.dialogs.length, 2, "another label raises its own dialog at once");
    assert.equal(r.dialogs[1].title.includes("other"), true);
    r.dialogs[1].answer(true);
    const res = await other;
    assert.equal(res.details.decision, "opened");
    assert.equal(r.spawned.length, 1);
    r.dialogs[0].answer(false);
    await sleep(20);
  } finally {
    r.cleanup();
  }
});

test("pending: a late Yes runs the open once and wakes the foreman with label, terminal, handoff dir and intercom id", async () => {
  const handoff = tmpDir();
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    await r.call({});
    assert.equal(r.woke.length, 0);
    // the registry entry foreman_session.py writes during the spawn
    r.registry({ label: "demo", child: "fm-demo-77", handoff, cwd: r.root, status: "open", backend: "herdr", workspace: "w1", tab: "t9", pane: "p9" });
    r.dialogs[0].answer(true);
    await sleep(50);
    assert.equal(r.spawned.length, 1);
    assert.equal(r.woke.length, 1);
    const w = r.woke[0];
    assert.equal(w.message.customType, "foreman_wake");
    assert.deepEqual(w.options, { triggerTurn: true });
    assert.match(w.message.content, /demo: opened/);
    assert.match(w.message.content, /Herdr tab t9/);
    assert.ok(w.message.content.includes(handoff));
    assert.match(w.message.content, /intercom id fm-demo-77/);
  } finally {
    r.cleanup();
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test("pending: a late No wakes with declined and spawns nothing", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    await r.call({});
    r.dialogs[0].answer(false);
    await sleep(50);
    assert.equal(r.spawned.length, 0);
    assert.equal(r.woke.length, 1);
    assert.match(r.woke[0].message.content, /^foreman_session_open demo: declined by the owner/);
    // the label is free again
    const next = r.call({});
    await sleep(20);
    assert.equal(r.dialogs.length, 2);
    r.dialogs[1].answer(false);
    assert.equal((await next).details.decision, "refused");
  } finally {
    r.cleanup();
  }
});

test("pending: a late Yes whose open fails wakes with the label and the reason", async () => {
  const r = rig({ confirmWaitSeconds: 0.05, spawn: () => ({ code: 1, stdout: "", stderr: "session open refused: brief file not found: b.md", timedOut: false }) });
  try {
    await r.call({});
    r.dialogs[0].answer(true);
    await sleep(50);
    assert.equal(r.woke.length, 1);
    assert.match(r.woke[0].message.content, /^foreman_session_open demo: open failed: .*brief file not found/);
  } finally {
    r.cleanup();
  }
});

test("answered inside the window: the open runs inline, no wake", async () => {
  const r = rig({ confirmWaitSeconds: 5 });
  try {
    const call = r.call({});
    await sleep(20);
    r.dialogs[0].answer(true);
    const res = await call;
    assert.equal(res.details.decision, "opened");
    assert.equal(r.spawned.length, 1);
    assert.equal(r.woke.length, 0);
  } finally {
    r.cleanup();
  }
});

test("confirmWaitSeconds 0 waits without limit; the answer then opens", async () => {
  const r = rig({ confirmWaitSeconds: 0 });
  try {
    const call = r.call({});
    assert.equal(await settlesWithin(call, 200), "blocked");
    r.dialogs[0].answer(true);
    assert.equal((await call).details.decision, "opened");
    assert.equal(r.spawned.length, 1);
  } finally {
    r.cleanup();
  }
});

test("abort inside the window withdraws the dialog, opens nothing, wakes nothing and frees the label", async () => {
  const r = rig({ confirmWaitSeconds: 5 });
  try {
    const ac = new AbortController();
    const call = r.call({}, ac.signal);
    await sleep(20);
    ac.abort();
    const res = await call;
    assert.equal(res.details.decision, "refused");
    assert.match(r.text(res), /cancelled.*dialog was withdrawn/);
    assert.equal(r.dialogs[0].signal?.aborted, true);
    await sleep(30);
    assert.equal(r.spawned.length, 0);
    assert.equal(r.woke.length, 0);
    const next = r.call({});
    await sleep(20);
    assert.equal(r.dialogs.length, 2, "a new open for the label raises a new dialog");
    r.dialogs[1].answer(false);
    await next;
  } finally {
    r.cleanup();
  }
});

test("abort with a UI that cannot withdraw: the late Yes opens nothing and is reported by wake", async () => {
  const r = rig({ confirmWaitSeconds: 5, honourSignal: false });
  try {
    const ac = new AbortController();
    const call = r.call({}, ac.signal);
    await sleep(20);
    ac.abort();
    await call;
    r.dialogs[0].answer(true);
    await sleep(30);
    assert.equal(r.spawned.length, 0);
    assert.equal(r.woke.length, 1);
    assert.match(r.woke[0].message.content, /cancelled.*nothing was opened/);
  } finally {
    r.cleanup();
  }
});

test("a call already aborted shows no dialog", async () => {
  const r = rig({ confirmWaitSeconds: 5 });
  try {
    const ac = new AbortController();
    ac.abort();
    const res = await r.call({}, ac.signal);
    assert.equal(res.details.decision, "refused");
    assert.equal(r.dialogs.length, 0);
    assert.equal(r.spawned.length, 0);
  } finally {
    r.cleanup();
  }
});

test("abort after the spawn started: the open runs to its end and its outcome is sent by wake", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const r = rig({ confirmWaitSeconds: 5, spawn: async () => (await gate, ok()) });
  try {
    const ac = new AbortController();
    const call = r.call({}, ac.signal);
    await sleep(20);
    r.dialogs[0].answer(true);
    await sleep(20);
    assert.equal(r.spawned.length, 1);
    ac.abort();
    await sleep(20);
    assert.equal(r.woke.length, 0, "nothing to report until the open ends");
    release();
    await call;
    assert.equal(r.woke.length, 1);
    assert.match(r.woke[0].message.content, /demo: opened/);
  } finally {
    r.cleanup();
  }
});

test("no UI still refuses with no_ui and spawns nothing", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const res = await r.call({}, undefined, { ...r.ctx, hasUI: false });
    assert.equal(r.text(res), NO_UI_REFUSAL);
    assert.equal(res.details.decision, "refused");
    assert.equal(r.spawned.length, 0);
    assert.equal(r.woke.length, 0);
  } finally {
    r.cleanup();
  }
});

test("--dry-run still shows no dialog", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const res = await r.call({ dryRun: true });
    assert.equal(res.details.decision, "opened");
    assert.equal(r.dialogs.length, 0);
    assert.equal(r.spawned.length, 1);
  } finally {
    r.cleanup();
  }
});

test("ownerConfirm passes the abort signal to the dialog only when given one", async () => {
  const calls: unknown[][] = [];
  const ctx = { hasUI: true, mode: "tui", ui: { confirm: async (...a: unknown[]) => (calls.push(a), true) } } as never;
  const ask = ownerConfirm(ctx, undefined)!;
  const ac = new AbortController();
  assert.equal(await ask("t", "m", ac.signal), true);
  assert.deepEqual(calls[0], ["t", "m", { signal: ac.signal }]);
});

test("already open: a registry label is named with terminal, handoff dir and intercom id; no dialog, no spawn", async () => {
  const handoff = tmpDir();
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const entry: SessionEntry = { label: "demo", child: "fm-demo-1", handoff, cwd: "/w/demo", status: "open", backend: "herdr", workspace: "w1", tab: "t1", pane: "p1" };
    r.registry(entry);
    let res = await r.call({});
    let text = r.text(res);
    assert.equal(res.details.decision, "refused");
    assert.match(text, /^session demo is already open in Herdr tab t1/);
    assert.ok(text.includes(`handoff dir ${handoff}`));
    assert.match(text, /intercom id fm-demo-1/);
    assert.match(text, /not live yet/);
    fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "live-id", piSessionId: "ps-1", at: "x" }));
    res = await r.call({});
    text = r.text(res);
    assert.match(text, /intercom id live-id/);
    assert.match(text, /live \(live\.json is written\)/);
    assert.equal(r.dialogs.length, 0);
    assert.equal(r.spawned.length, 0);
    // a closed or failed entry does not block a new open
    r.registry({ ...entry, status: "closed" });
    const next = r.call({});
    await sleep(20);
    assert.equal(r.dialogs.length, 1);
    r.dialogs[0].answer(false);
    await next;
  } finally {
    r.cleanup();
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test("worktree path refusal: names the registered session that owns the path, else says none is registered", async () => {
  const handoff = tmpDir();
  const refuse = (): SpawnResult => ({ code: 1, stdout: "", stderr: "session open refused: the worktree path exists: /w/demo", timedOut: false });
  const r = rig({ confirmWaitSeconds: 5, spawn: refuse });
  try {
    const ask = async (): Promise<string> => {
      const n = r.dialogs.length;
      const call = r.call({ worktree: true });
      await sleep(20);
      r.dialogs[n].answer(true);
      return r.text(await call);
    };
    let text = await ask();
    assert.match(text, /the worktree path exists: \/w\/demo/, "the refusal stays");
    assert.match(text, /No session is registered for that worktree path/);
    r.registry({ label: "earlier", child: "fm-earlier-1", handoff, cwd: "/w/demo", status: "open", backend: "herdr", workspace: "w", tab: "t", pane: "p" });
    text = await ask();
    assert.match(text, /the worktree path exists/);
    assert.match(text, /The worktree belongs to session earlier, which is already open in Herdr tab t/);
    assert.ok(text.includes(handoff));
    r.registry({ label: "earlier", child: "fm-earlier-1", handoff, cwd: "/w/demo", status: "closed" });
    text = await ask();
    assert.match(text, /The worktree belongs to the earlier session earlier \(closed\)/);
    assert.equal(readRegistry(r.agentDir).sessions.length, 1);
    assert.ok(fs.existsSync(registryFile(r.agentDir)));
  } finally {
    r.cleanup();
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test("wait child: a wait armed before the session exists resolves on that label's first notice after the open", () => {
  const woke: Outcome[][] = [];
  const timers: Timers = { set: () => 1, clear: () => undefined };
  const rt = new WaitRuntime({ timers, now: () => 0, limits: () => ({ batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true }), stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => woke.push(o), trace: () => undefined });
  const dir = tmpDir();
  try {
    // armed first: the registry has no such label, the wait is accepted
    assert.ok("id" in rt.start({ kind: "child", label: "later", note: "n" }));
    assert.equal(readRegistry(dir).sessions.length, 0);
    assert.equal(rt.active, 1);
    // the open writes the entry; the child's first report arrives
    const reg = { version: 1, sessions: [{ label: "later", child: "fm-later-1", status: "pending" } as SessionEntry] };
    const msg = parseInbound("Plan from later: /h/plan.md")!;
    const entry = applyInbound(reg, "fm-later-1", msg, new Date(0));
    assert.ok(entry);
    assert.equal(rt.childNotice(entry.label, msg.kind, msg.path), true);
    assert.equal(woke[0][0].outcome, "child later: plan /h/plan.md");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
