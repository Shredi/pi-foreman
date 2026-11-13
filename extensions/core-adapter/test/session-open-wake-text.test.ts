// The wake after a confirmed open words the normal state plainly; the "already open" refusal keeps its adopt text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "../session.ts";
import { rig, sleep } from "./_session-open-rig.ts";

const tmpDir = (): string => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-open-wake-")));

async function wakeOf(handoff: string, live: boolean): Promise<string> {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    await r.call({});
    r.registry({ label: "demo", child: "fm-demo-77", handoff, cwd: r.root, status: "open", backend: "herdr", workspace: "w1", tab: "t9", pane: "p9" });
    if (live) fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "live-id", piSessionId: "ps-1", at: "x" }));
    r.dialogs[0].answer(true);
    await sleep(50);
    assert.equal(r.woke.length, 1);
    return r.woke[0].message.content;
  } finally {
    r.cleanup();
  }
}

test("wake after a confirmed open: opened and starting, how to wait, no 'not live yet', no adopt hint", async () => {
  const handoff = tmpDir();
  try {
    const text = await wakeOf(handoff, false);
    assert.equal(
      text,
      `foreman_session_open demo: opened in Herdr tab t9 (workspace w1, pane p9), handoff dir ${handoff}; intercom id fm-demo-77; status open; starting (live.json appears once the session has started). Wait for its plan or result with foreman_wait kind child on demo.`,
    );
    assert.doesNotMatch(text, /not live yet|Adopt it|pick another label/);
  } finally {
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test("wake after a confirmed open with live.json already written says live", async () => {
  const handoff = tmpDir();
  try {
    const text = await wakeOf(handoff, true);
    assert.match(text, /intercom id live-id; status open; live \(live\.json is written\)\. Wait for its plan or result with foreman_wait kind child on demo\.$/);
    assert.doesNotMatch(text, /starting|not live yet|Adopt it/);
  } finally {
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test("the already-open refusal keeps its text, adopt hint included", async () => {
  const handoff = tmpDir();
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const entry: SessionEntry = { label: "demo", child: "fm-demo-1", handoff, cwd: "/w/demo", status: "open", backend: "herdr", workspace: "w1", tab: "t1", pane: "p1" };
    r.registry(entry);
    const text = r.text(await r.call({}));
    assert.equal(
      text,
      `session demo is already open in Herdr tab t1 (workspace w1, pane p1), handoff dir ${handoff}; intercom id fm-demo-1; status open; not live yet (no live.json). Adopt it: foreman_wait kind child on its label, or foreman session brief; close it or pick another label to open a new one.`,
    );
  } finally {
    r.cleanup();
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});
