import { test } from "node:test";
import assert from "node:assert/strict";
import { panelChecksLine } from "../panelchecks.ts";
import type { PanelChecksCache } from "../panelchecks.ts";

function deps(over: { block?: boolean; head?: string | null } = {}) {
  const st = { fetches: 0, turn: 1, head: over.head === undefined ? "aaa" : over.head };
  return {
    st,
    d: {
      enabled: () => true,
      preflight: async () => (over.block ? { block: true as const, reason: "drift" } : undefined),
      head: async () => st.head,
      turn: () => st.turn,
      fetch: async () => (st.fetches++, "checks: 1 failed"),
    },
  };
}

test("panel checks: two panels in one turn on the same HEAD call the host once; a new turn or HEAD calls again", async () => {
  const { st, d } = deps();
  const cache: { current: PanelChecksCache | null } = { current: null };
  assert.equal(await panelChecksLine(d, cache), "checks: 1 failed");
  assert.equal(await panelChecksLine(d, cache), "checks: 1 failed");
  assert.equal(st.fetches, 1);
  st.head = "bbb";
  await panelChecksLine(d, cache);
  st.turn = 2;
  await panelChecksLine(d, cache);
  assert.equal(st.fetches, 3);
});

test("panel checks: a blocked drift preflight omits the line with no host call", async () => {
  const { st, d } = deps({ block: true });
  assert.equal(await panelChecksLine(d, { current: null }), "");
  assert.equal(st.fetches, 0);
});
