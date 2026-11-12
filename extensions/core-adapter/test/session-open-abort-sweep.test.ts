// foreman_session_open: the owner's Yes, then k microtask yields, then the call's abort: whatever k, both sides agree on whether a spawn ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rig, sleep } from "./_session-open-rig.ts";

const OPENED = /opened in Herdr/;
const CLAIMS_NOTHING = /nothing was opened/;

for (const told of [false, true]) {
  for (let k = 0; k <= 13; k++) {
    test(`Yes, ${k} microtask yields, abort (${told ? "second caller told" : "no second caller"}): spawn and reports agree`, async () => {
      const r = rig({ confirmWaitSeconds: 5, spawn: () => ({ code: 0, stdout: "opened in Herdr: tab t9", stderr: "", timedOut: false }) });
      try {
        const ac = new AbortController();
        const first = r.call({}, ac.signal);
        await sleep(20);
        if (told) assert.equal((await r.call({})).details.decision, "pending");
        r.dialogs[0].answer(true);
        for (let i = 0; i < k; i++) await Promise.resolve();
        ac.abort();
        const res = await first;
        await sleep(30);
        const text = r.text(res);
        assert.ok(r.spawned.length <= 1, `spawns: ${r.spawned.length}`);
        assert.ok(r.woke.length <= 1, `wakes: ${r.woke.length}`);
        const wakes = r.woke.map((w) => w.message.content);
        if (r.spawned.length === 1) {
          assert.ok(OPENED.test(text) || (wakes.length === 1 && OPENED.test(wakes[0])), `a spawn ran but nobody was told: ${text} | ${wakes.join("|")}`);
          assert.doesNotMatch(text, CLAIMS_NOTHING);
        } else {
          assert.doesNotMatch(text, OPENED);
          for (const w of wakes) assert.doesNotMatch(w, OPENED);
        }
      } finally {
        r.cleanup();
      }
    });
  }
}
