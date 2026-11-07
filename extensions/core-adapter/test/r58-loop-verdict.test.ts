// reviewloop.ts: the pure loop rule (repeat, stalled) and the finding set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingKey, loopVerdict, sigOf } from "../reviewloop.ts";
import type { LoopRound } from "../reviewloop.ts";
import type { PanelFinding } from "../panel.ts";

const fail = (state: string, ...sig: string[]): LoopRound => ({ verdict: "fail", state, sig });
const pass = (state: string): LoopRound => ({ verdict: "pass", state, sig: [] });

test("loopVerdict table", () => {
  const rows: [string, LoopRound | null, LoopRound, ReturnType<typeof loopVerdict>][] = [
    ["first round never trips", null, fail("s1", "item:1"), null],
    ["same sig, new diff = repeat", fail("s1", "item:1"), fail("s2", "item:1"), "repeat"],
    ["same sig, same state = repeat", fail("s1", "item:1", "item:2"), fail("s1", "item:2", "item:1"), "repeat"],
    ["subset of the findings, same state = stalled", fail("s1", "item:1", "item:2"), fail("s1", "item:1"), "stalled"],
    ["subset of the findings, new diff = progress", fail("s1", "item:1", "item:2"), fail("s2", "item:1"), null],
    ["a new finding, same state = not stalled", fail("s1", "item:1"), fail("s1", "item:1", "item:2"), null],
    ["a new finding, new diff", fail("s1", "item:1"), fail("s2", "item:2"), null],
    ["empty sig is never the same", fail("s1"), fail("s1"), null],
    ["empty sig now, findings before", fail("s1", "item:1"), fail("s1"), null],
    ["unknown state is never equal", fail("", "item:1", "item:2"), fail("", "item:1"), null],
    ["the round before passed: the comparison restarted", pass("s1"), fail("s1", "item:1"), null],
    ["a PASS never trips", fail("s1", "item:1"), pass("s1"), null],
  ];
  for (const [name, prev, cur, want] of rows) assert.equal(loopVerdict(prev, cur), want, name);
});

test("sigOf: FAIL items and located findings, sorted and de-duplicated; a PASS or an empty report has none", () => {
  const f = (file: string, line: number | null, cls: string): PanelFinding => ({ file, line, class: cls, note: "n" }) as PanelFinding;
  const report = "2. FAIL: b\n1. FAIL: a\n3. PASS: c\nOverall verdict: FAIL";
  assert.deepEqual(sigOf(report, [f("a.ts", 12, "bug"), f("a.ts", 14, "bug"), f("b.ts", null, "style")]), ["at:a.ts:2:bug", "at:b.ts:-:style", "item:1", "item:2"]);
  assert.deepEqual(sigOf("Overall verdict: PASS", []), []);
  assert.deepEqual(sigOf("Overall verdict: FAIL", []), []);
  assert.equal(findingKey(f("x.ts", 4, "c")), "at:x.ts:0:c");
  assert.equal(findingKey(f("x.ts", 5, "c")), "at:x.ts:1:c");
});
