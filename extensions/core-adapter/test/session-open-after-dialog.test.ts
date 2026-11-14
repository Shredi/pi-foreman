// foreman_session_open guards the rule "a tool open always shows its own confirm": made right after another dialog was answered in the same
// tick it still raises its own dialog and opens nothing before the answer; only a dry run shows none, by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rig, sleep } from "./_session-open-rig.ts";

test("a tool open right after another dialog was answered shows its own confirm and opens nothing before the answer", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    const first = r.call({ label: "first" });
    await sleep(20);
    assert.equal(r.dialogs.length, 1);
    r.dialogs[0].answer(true); // answered, and the next open starts in the same tick
    const second = r.call({ label: "second" });
    await first;
    await sleep(20);
    assert.equal(r.dialogs.length, 2, "the second open raised its own dialog");
    assert.equal(r.dialogs[1].title.includes("second"), true);
    assert.equal(r.spawned.length, 1, "only the answered open ran");
    r.dialogs[1].answer(true);
    const res = await second;
    assert.equal(res.details.decision, "opened");
    assert.equal(r.spawned.length, 2);
  } finally {
    r.cleanup();
  }
});

test("a dry run shows no confirm, by design", async () => {
  const r = rig({ confirmWaitSeconds: 0.05 });
  try {
    await r.call({ label: "plan", dryRun: true });
    assert.equal(r.dialogs.length, 0);
  } finally {
    r.cleanup();
  }
});
