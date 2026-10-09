import { test } from "node:test";
import assert from "node:assert/strict";
import { addHints, citedItems, hintTargets, hintText, HINT_LEN, ledgerHint } from "../hints.ts";
import { buildDigest, countersLine, extractRetro, lastAssistantText, retroEntry, knownLimitsArg, modelRetroPrompt, MODEL_RETRO_PROMPT, KNOWN_LIMITS_MAX_CHARS, DIGEST_MAX_LINES } from "../retrodigest.ts";

const LEDGER = "# L\n\n- [ ] 1. a\n- [x] 2. b\n```\n- [ ] 1. fenced\n```\n- [ ] V. verify\n";

test("hints: at most 3 per item, oldest dropped, other items untouched", () => {
  let f = LEDGER;
  for (let i = 1; i <= 5; i++) f = addHints(f, ["1"], hintText("2026-10-09", `h${i}`)).file;
  assert.equal(f, "# L\n\n- [ ] 1. a\n  > 2026-10-09 h3\n  > 2026-10-09 h4\n  > 2026-10-09 h5\n- [x] 2. b\n```\n- [ ] 1. fenced\n```\n- [ ] V. verify\n");
  const r = addHints(f, ["9", "V"], hintText("2026-10-09", "x"));
  assert.deepEqual(r.added, ["V"]);
  assert.ok(r.file.endsWith("- [ ] V. verify\n  > 2026-10-09 x\n"));
  assert.equal(addHints("- [ ] 1. a\r\n- [ ] V. v\r\n", ["1"], "> d t").file, "- [ ] 1. a\r\n  > d t\r\n- [ ] V. v\r\n");
});

test("hints: one line, bounded; targets fall back to V", () => {
  const h = hintText("2026-10-09", `a\nb ${"z".repeat(300)}`);
  assert.equal(h.length, HINT_LEN);
  assert.ok(h.startsWith("> 2026-10-09 a b z"));
  assert.deepEqual(citedItems("fix items 1, 3 and V; see #4\n2. quoted line"), ["1", "3", "V", "4", "2"]);
  assert.deepEqual(hintTargets(["1", "7"], LEDGER), ["1"]);
  assert.deepEqual(hintTargets([], LEDGER), ["V"]);
  assert.deepEqual(hintTargets([], "- [ ] 1. a\n"), []);
  assert.equal(ledgerHint("status", "", "", undefined), null);
  assert.deepEqual(ledgerHint("add", "", "added 5: - [ ] 5. e", "e"), { ids: ["5"], text: "ledger add: e" });
  assert.deepEqual(ledgerHint("mark", "1,V", "", undefined), { ids: ["1", "V"], text: "ledger mark" });
});

test("digest: open items, closed since last, last 8 hints, bounded", () => {
  const hints = Array.from({ length: 12 }, (_, i) => `1: 2026-10-09 h${i}`);
  const d = buildDigest({ ledgerPath: "/w/.workflow/LEDGER-x.md", ledger: LEDGER, closedBefore: new Set(), hints });
  assert.match(d.text, /LEDGER-x\.md is the source of truth/);
  assert.match(d.text, /Open items: 2\n- \[ \] 1\. a\n- \[ \] V\. verify/);
  assert.match(d.text, /Closed since the last compaction: 2/);
  assert.ok(!d.text.includes("h3\n") && d.text.includes("h4") && d.text.includes("h11"));
  assert.match(buildDigest({ ledgerPath: "/l", ledger: LEDGER, closedBefore: d.closed, hints: [] }).text, /Closed since the last compaction: none/);
  const big = Array.from({ length: 80 }, (_, i) => `- [ ] ${i + 1}. item`).join("\n");
  const b = buildDigest({ ledgerPath: "/l", ledger: big, closedBefore: new Set(), hints }).text.split("\n");
  assert.equal(b.length, DIGEST_MAX_LINES);
  assert.ok(b.some((l) => /more open item\(s\)/.test(l)));
});

test("retro: extract the section, counters line, entry, assistant text", () => {
  const s = "## Goal\nx\n\n## Retro\n- missing: allow rule for make\n- enhance: brief\n\n## Next\ny";
  assert.equal(extractRetro(s), "- missing: allow rule for make\n- enhance: brief");
  assert.equal(extractRetro("no section"), null);
  assert.equal(extractRetro(`## Retro\n${"l\n".repeat(20)}`)?.split("\n").length, 10);
  assert.equal(countersLine(null), "counters: no data");
  assert.equal(countersLine({ trace: { guard_blocks: { g: 2 }, overlay_blocks: 1, rereviews: 1, budget_hits: 2, rung_up: 1, child_read_budget: 0, review_defer_headless: 3, turns: 7 }, review: { human_denied: 1 } }), "counters: denies=4 rereviews=1 budget_hits=2 rung_up=1 child_read_budget=0 review_defer_headless=3 turns=7");
  assert.match(retroEntry({ when: new Date("2026-10-09T10:00:00.123Z"), reason: "threshold", counters: "counters: x", retro: null }), /^## 2026-10-09T10:00:00Z compaction \(threshold\)\n\ncounters: x\n\n\(the compaction summary has no Retro section\)/);
  assert.equal(lastAssistantText([{ role: "assistant", content: [{ type: "text", text: "a" }] }, { role: "user", content: "u" }]), "a");
});

test("known limits: the flag is parsed and the block is capped; empty adds nothing", () => {
  assert.equal(knownLimitsArg("--model --known-limits /opt/k.md"), "/opt/k.md");
  assert.equal(knownLimitsArg("--model"), null);
  assert.equal(modelRetroPrompt(null), MODEL_RETRO_PROMPT);
  assert.equal(modelRetroPrompt("  "), MODEL_RETRO_PROMPT);
  const p = modelRetroPrompt("x".repeat(KNOWN_LIMITS_MAX_CHARS + 50));
  assert.match(p, /rig facts, not harness gaps; do not list them under Missing:/);
  assert.equal(p.split("x").length - 1, KNOWN_LIMITS_MAX_CHARS);
});
