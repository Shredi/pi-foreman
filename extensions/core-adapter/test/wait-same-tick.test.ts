// Outcomes resolving in the same tick go out as one leading-edge wake (delivered on the next macrotask); later ones of the window batch.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Governor, realTimers, type Outcome } from "../wait.ts";

const out = (id: string): Outcome => ({ id, kind: "pressure", note: id, outcome: "elapsed" });

test("same-tick pressure outcomes join one leading-edge wake; a later one inside the window is batched", async () => {
  const sent: string[][] = [];
  const g = new Governor({ windowMs: () => 60_000, active: () => 1, timers: realTimers, send: (o) => void sent.push(o.map((x) => x.id)) });
  try {
    g.resolved(out("a"));
    g.resolved(out("b"));
    assert.equal(sent.length, 0, "nothing is sent inside the tick");
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(sent, [["a", "b"]]);
    g.resolved(out("c"));
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(sent.length, 1, "c waits for the window to close");
  } finally {
    g.dispose();
  }
});
