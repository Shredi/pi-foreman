import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSpawn, beforeSpawn, escalate, gateThreshold, initialCeremony, ledgerTier, onFileChanged, parseTierHeader, promptSignals, userOverride } from "../ceremony.ts";

test("automatic changes only escalate", () => {
  let s = escalate(initialCeremony("standard"), "heavy", "auto", "signal");
  assert.equal(s.tier, "heavy");
  s = escalate(s, "standard", "auto", "x");
  assert.equal(s.tier, "heavy");
  s = escalate(s, "trivial", "ledger", "ledger says trivial");
  assert.equal(s.tier, "heavy");
});

test("the config default is not a triage: the ledger header may set any tier", () => {
  const s = escalate(initialCeremony("standard"), "trivial", "ledger", "Tier: trivial");
  assert.equal(s.tier, "trivial");
  assert.equal(s.source, "ledger");
});

test("/ceremony override goes both ways", () => {
  let s = userOverride(initialCeremony("standard"), "heavy");
  assert.equal(s.tier, "heavy");
  s = userOverride(s, "trivial");
  assert.equal(s.tier, "trivial");
  assert.equal(s.source, "user");
});

test("tier meets the gate through LEDGER_GUARD_THRESHOLD", () => {
  assert.equal(gateThreshold(initialCeremony("standard")), null);
  assert.equal(gateThreshold(userOverride(initialCeremony("standard"), "trivial")), null);
  assert.equal(gateThreshold(userOverride(initialCeremony("trivial"), "standard")), 0);
  assert.equal(gateThreshold(escalate(initialCeremony("standard"), "heavy", "auto", "x")), 0);
});

test("trivial allows one explorer launch; the next launch escalates to standard", () => {
  let s = userOverride(initialCeremony("standard"), "trivial");
  s = beforeSpawn(s, ["explorer"]);
  assert.equal(s.tier, "trivial");
  s = afterSpawn(s);
  s = beforeSpawn(s, ["explorer"]);
  assert.equal(s.tier, "standard");
  assert.equal(beforeSpawn(userOverride(initialCeremony("standard"), "trivial"), ["builder"]).tier, "standard");
});

test("ledger header, file count and prompt signals", () => {
  assert.equal(parseTierHeader("# LEDGER\n\nTier: heavy\n- [ ] 1. x"), "heavy");
  assert.equal(parseTierHeader("# L\n**Tier:** standard"), "standard");
  assert.equal(parseTierHeader("# L\n- [ ] 1. tier: heavy later"), null);
  let s = initialCeremony("standard");
  for (const f of ["/r/a", "/r/b", "/r/b", "/r/.workflow/LEDGER-x.md", "/r/c"]) s = onFileChanged(s, f, 2);
  assert.equal(s.tier, "heavy");
  assert.deepEqual(promptSignals("Please fix CI and the public API docs", ["ci", "public-api", "auth"]), ["ci", "public-api"]);
  assert.deepEqual(promptSignals("decide on a city", ["ci"]), []);
  assert.deepEqual(promptSignals("we are deleting old rows", ["delete"]), ["delete"]);
});

test("a bound ledger without a Tier: line counts as standard; no ledger stays untriaged", () => {
  const untriaged = initialCeremony("standard");
  assert.equal(gateThreshold(untriaged), null);
  const { tier, reason } = ledgerTier("# LEDGER\n\n- [ ] 1. x");
  assert.equal(tier, "standard");
  const bound = escalate(untriaged, tier, "ledger", reason);
  assert.deepEqual([bound.tier, bound.source], ["standard", "ledger"]);
  assert.equal(gateThreshold(bound), 0);
  assert.equal(ledgerTier("# L\nTier: trivial").tier, "trivial");
});
