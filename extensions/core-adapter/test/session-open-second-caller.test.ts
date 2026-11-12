// foreman_session_open: a second caller told "pending" gets the outcome by wake (once); config fallback; a throwing wake.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { rig, sleep } from "./_session-open-rig.ts";
import type { SpawnResult } from "../spawn.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("second caller inside the first call's wait window: told pending, one wake with the outcome, one spawn", async () => {
  const r = rig({ confirmWaitSeconds: 5 });
  try {
    const first = r.call({});
    await sleep(20);
    const second = await r.call({});
    assert.equal(second.details.decision, "pending");
    assert.match(r.text(second), /foreman_wake/);
    assert.equal(r.dialogs.length, 1);
    r.dialogs[0].answer(true);
    const res = await first;
    assert.equal(res.details.decision, "opened");
    await sleep(30);
    assert.equal(r.spawned.length, 1);
    assert.equal(r.woke.length, 1, "exactly one wake");
    assert.match(r.woke[0].message.content, /opened/);
  } finally {
    r.cleanup();
  }
});

test("second caller during the first call's spawn: says the open runs now, one wake, one spawn", async () => {
  let release!: (v: SpawnResult) => void;
  const gate = new Promise<SpawnResult>((res) => (release = res));
  const r = rig({ confirmWaitSeconds: 5, spawn: () => gate });
  try {
    const first = r.call({});
    await sleep(20);
    r.dialogs[0].answer(true);
    await sleep(20);
    assert.equal(r.spawned.length, 1);
    const second = await r.call({});
    assert.equal(second.details.decision, "pending");
    const text = r.text(second);
    assert.match(text, /being opened now/);
    assert.doesNotMatch(text, /nothing is spawned until/);
    assert.match(text, /foreman_wake/);
    release({ code: 0, stdout: "opened in Herdr: tab t9", stderr: "", timedOut: false });
    assert.equal((await first).details.decision, "opened");
    await sleep(30);
    assert.equal(r.spawned.length, 1);
    assert.equal(r.woke.length, 1, "exactly one wake");
    assert.match(r.woke[0].message.content, /opened/);
  } finally {
    r.cleanup();
  }
});

test("a non-finite confirmWaitSeconds falls back to the default 20 s, not to waiting without limit", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const r = rig({ confirmWaitSeconds: Number.NaN });
  try {
    let done = false;
    const call = r.call({}).then((x) => ((done = true), x));
    await tick();
    await tick();
    mock.timers.tick(19_000);
    await tick();
    assert.equal(done, false, "still inside the default window");
    mock.timers.tick(1_000);
    const res = await call;
    assert.equal(res.details.decision, "pending");
    r.dialogs[0].answer(false);
    await tick();
  } finally {
    mock.timers.reset();
    r.cleanup();
  }
});

test("a throwing sendMessage in the late-answer wake is not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const on = (e: unknown): number => unhandled.push(e);
  process.on("unhandledRejection", on);
  const r = rig({ confirmWaitSeconds: 0.05, sendThrows: true });
  try {
    const res = await r.call({});
    assert.equal(res.details.decision, "pending");
    r.dialogs[0].answer(false);
    await sleep(50);
    assert.equal(unhandled.length, 0);
    assert.equal(r.woke.length, 0);
  } finally {
    process.off("unhandledRejection", on);
    r.cleanup();
  }
});

for (const [name, honourSignal, late] of [
  ["UI honours the signal", true, undefined],
  ["UI ignores the signal, late No", false, false],
  ["UI ignores the signal, late Yes", false, true],
] as const) {
  test(`second caller told pending, first call aborted (${name}): one wake, zero spawns`, async () => {
    const r = rig({ confirmWaitSeconds: 5, honourSignal });
    try {
      const ac = new AbortController();
      const first = r.call({}, ac.signal);
      await sleep(20);
      const second = await r.call({});
      assert.equal(second.details.decision, "pending");
      ac.abort();
      await first;
      if (late !== undefined) r.dialogs[0].answer(late);
      await sleep(30);
      assert.equal(r.woke.length, 1, "exactly one wake");
      assert.match(r.woke[0].message.content, /cancelled/);
      assert.match(r.woke[0].message.content, /nothing was opened/);
      assert.equal(r.spawned.length, 0);
      const again = r.call({});
      await sleep(20);
      assert.equal(r.dialogs.length, 2, "label is free again: a new dialog");
      r.dialogs[1].answer(false);
      await again;
    } finally {
      r.cleanup();
    }
  });
}
