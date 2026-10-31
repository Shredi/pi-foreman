import { test } from "node:test";
import assert from "node:assert/strict";
import { latestWaits, lostWaitsMessage, WAITS_ENTRY, waitsEntry } from "../waitstate.ts";
import { WAKE_MESSAGE_TYPE } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

const entry = (data: unknown) => [{ type: "custom", customType: WAITS_ENTRY, data }];

test("waitsEntry: pressure waits are not stored, bg and notes are", () => {
  const e = waitsEntry("s", [
    { id: "w1", kind: "timer", note: "n" },
    { id: "w2", kind: "pressure", note: "" },
    { id: "w3", kind: "pid", note: "build", bg: true },
  ]);
  assert.deepEqual(e, { v: 1, piSessionId: "s", waits: [{ id: "w1", kind: "timer", note: "n" }, { id: "w3", kind: "pid", note: "build", bg: true }] });
});

test("latestWaits / lostWaitsMessage: same id names the lost waits, other id and empty set say nothing", () => {
  const stored = waitsEntry("s", [{ id: "w1", kind: "timer", note: "nightly" }, { id: "w2", kind: "pid", note: "", bg: true }]);
  const msg = lostWaitsMessage(latestWaits(entry(stored), "s"));
  assert.equal(msg?.customType, WAKE_MESSAGE_TYPE);
  assert.match(msg!.content, /foreman_wait lost on restart: 2 waits/);
  assert.match(msg!.content, /- w1 \(timer\) "nightly"/);
  assert.match(msg!.content, /- w2 \(bg pid\)/);
  assert.equal(lostWaitsMessage(latestWaits(entry(stored), "other")), null);
  assert.equal(lostWaitsMessage(latestWaits(entry(waitsEntry("s", [])), "s")), null);
  assert.equal(lostWaitsMessage(latestWaits([], "s")), null);
  assert.match(lostWaitsMessage(latestWaits(entry({ v: 1, piSessionId: "s", waits: "x" }), "s"))!.content, /unreadable/);
});

test("wiring: a resumed session gets one lost notice, the set is emptied, another id gets nothing", async (t) => {
  for (const [stored, mine, expected] of [["sid-a", "sid-a", 1], ["sid-b", "sid-a", 0]] as const) {
    const sent: { customType: string; content: string }[] = [];
    const appended: { type: string; data: unknown }[] = [];
    const branch = entry(waitsEntry(stored, [{ id: "w1", kind: "timer", note: "later" }]));
    const rig = await r11Rig(t, {}, {
      ctx: { sessionManager: { getSessionId: () => mine, getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch } },
      piExtra: { appendEntry: (type: string, data: unknown) => void appended.push({ type, data }), sendMessage: (m: { customType: string; content: string }) => void sent.push(m), registerTool: () => undefined },
    });
    const lost = sent.filter((m) => m.customType === WAKE_MESSAGE_TYPE);
    assert.equal(lost.length, expected);
    const sets = appended.filter((a) => a.type === WAITS_ENTRY);
    assert.equal(sets.length, expected);
    if (expected) {
      assert.match(lost[0].content, /w1 \(timer\) "later"/);
      assert.deepEqual(sets[0].data, { v: 1, piSessionId: mine, waits: [] });
      assert.equal(rig.events("wait").filter((e) => e.decision === "lost").length, 1);
    }
    await rig.fire("session_shutdown", {});
    assert.equal(appended.filter((a) => a.type === WAITS_ENTRY).length, expected);
  }
});
