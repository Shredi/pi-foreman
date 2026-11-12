// The three defects of the foreman_session_open confirm dialog, each as a test that failed before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rig, settlesWithin, sleep } from "./_session-open-rig.ts";

test("defect 1: the open call does not block while its confirm dialog is unanswered", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const call = r.call({});
    const state = await settlesWithin(call, 1500);
    // release the dialog so a failing run does not leave the call hanging
    r.dialogs[0]?.answer(false);
    assert.equal(state, "returned", "the call is still waiting for the owner's answer");
    assert.equal(r.spawned.length, 0, "nothing is spawned without an answer");
  } finally {
    r.cleanup();
  }
});

test("defect 2: a cancelled call leaves no dialog whose late answer opens a session nobody hears about", async () => {
  // a UI that ignores the signal is the worst case: the dialog stays and is answered later
  const r = rig({ honourSignal: false });
  try {
    const ac = new AbortController();
    const call = r.call({}, ac.signal);
    await sleep(20);
    assert.equal(r.dialogs.length, 1);
    ac.abort();
    await settlesWithin(call, 500);
    r.dialogs[0].answer(true);
    await sleep(100);
    assert.equal(r.spawned.length, 0, "the late Yes of a cancelled call opened a session");
    await call.catch(() => undefined);
  } finally {
    r.cleanup();
  }
});

test("defect 3: a second open for a label already in the registry names that session, not the worktree path", async () => {
  const handoff = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-handoff-"))), "demo");
  fs.mkdirSync(handoff, { recursive: true });
  const r = rig({ spawn: () => ({ code: 1, stdout: "", stderr: "session open refused: the worktree path exists: /w/demo", timedOut: false }) });
  try {
    r.registry({ label: "demo", child: "fm-demo-1", handoff, cwd: "/w/demo", status: "open", backend: "herdr", tab: "t1", pane: "p1", workspace: "w1" });
    const call = r.call({ worktree: true });
    const state = await settlesWithin(call, 300);
    r.dialogs[0]?.answer(true);
    const res = await call;
    assert.equal(state, "returned", "the owner was asked about a label that is already open");
    assert.equal(r.spawned.length, 0);
    const text = r.text(res);
    assert.match(text, /session demo is already open/);
    assert.ok(text.includes(handoff), text);
    assert.doesNotMatch(text, /worktree path exists/);
  } finally {
    r.cleanup();
    fs.rmSync(path.dirname(handoff), { recursive: true, force: true });
  }
});
