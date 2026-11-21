// reviewloop.ts: the pure loop rule (repeat, stalled) and the finding set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingKey, loopVerdict, sigOf } from "../reviewloop.ts";
import type { LoopRound } from "../reviewloop.ts";
import type { VerdictFinding } from "../verdict.ts";

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

test("sigOf: failed items and defect findings keyed on their text, sorted and de-duplicated; a pass or an empty record has none", () => {
  const f = (file: string | undefined, line: number | undefined, cls: string | undefined, kind: VerdictFinding["kind"] = "defect"): VerdictFinding => ({ kind, text: "n", file, line, class: cls });
  const items = [{ id: 2, result: "fail" }, { id: 1, result: "fail" }, { id: 3, result: "pass" }, { id: 4, result: "open" }, { id: 1, result: "fail" }] as const;
  const findings = [f("a.ts", 12, "bug"), f("a.ts", 14, "bug"), f("b.ts", undefined, "style"), f(undefined, 3, "bug"), f("c.ts", 1, "bug", "later")];
  assert.deepEqual(sigOf(items, findings), ["item:1", "item:2", "txt:n"]);
  assert.deepEqual(sigOf([{ id: 1, result: "pass" }], []), []);
  assert.deepEqual(sigOf([], []), []);
  assert.equal(findingKey({ file: "x.ts", line: 4, class: "c" }), "at:x.ts:0:c");
  assert.equal(findingKey({ file: "x.ts", line: 5, class: "c" }), "at:x.ts:1:c");
});
