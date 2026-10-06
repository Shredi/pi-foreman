import { test } from "node:test";
import assert from "node:assert/strict";
import { abbrev, footerText, UsageFooter, zeroTotals, addMessage } from "../footer.ts";

const MSG = { role: "assistant", usage: { input: 10000, output: 2300, cacheRead: 1_000_000, cacheWrite: 200_000, cost: { input: 0.05, output: 0.1, cacheRead: 0.5, cacheWrite: 0.25, total: 0.9 } } };

test("abbreviations", () => {
  assert.equal(abbrev(999), "999");
  assert.equal(abbrev(12345), "12.3k");
  assert.equal(abbrev(1_234_567), "1.2M");
});

test("foreman text has warm/cold split and children; child text has no children", () => {
  const t = zeroTotals();
  addMessage(t, MSG);
  assert.equal(footerText(t, 3), "↑1.2M ↓2.3k tok · $0.90 list (warm $0.50 / cold $0.30) · children 3");
  assert.equal(footerText(t, null), "↑1.2M ↓2.3k tok · $0.90 list (warm $0.50 / cold $0.30)");
});

test("zero reported cost is priced from the registry (bridge -> anthropic); no price shows n/a", () => {
  const bridge = { role: "assistant", provider: "claude-bridge", model: "claude-x", usage: { input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000, cacheWrite: 1_000_000, cost: { total: 0 } } };
  const asked: string[] = [];
  const registry = { find: (p: string, m: string) => (asked.push(`${p}/${m}`), p === "anthropic" && m === "claude-x" ? { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } : undefined) };
  const t = zeroTotals();
  addMessage(t, bridge, registry);
  assert.deepEqual(asked, ["anthropic/claude-x"]);
  assert.equal(footerText(t, null), "↑4.0M ↓1.0M tok · $22.35 list (warm $0.60 / cold $6.75)");
  const n = zeroTotals();
  addMessage(n, bridge, { find: () => undefined });
  assert.equal(footerText(n, null), "↑4.0M ↓1.0M tok · n/a list (warm n/a / cold n/a)");
  addMessage(n, MSG);
  assert.match(footerText(n, null), /\$0\.90 \+ n\/a list/);
});

test("update sets status in tui/rpc, no-op in print/json or when disabled, never throws", () => {
  const calls: string[] = [];
  const mk = (mode: string) => ({ mode, ui: { setStatus: (k: string, v: string | undefined) => calls.push(`${k}=${v}`) } });
  const f = new UsageFooter();
  f.update("s", mk("print"), MSG, { enabled: true, isChild: false, children: 0 });
  f.update("s", mk("json"), MSG, { enabled: true, isChild: false, children: 0 });
  f.update("s", mk("tui"), MSG, { enabled: false, isChild: false, children: 0 });
  assert.deepEqual(calls, []);
  f.update("s", mk("rpc"), MSG, { enabled: true, isChild: false, children: 2 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^foreman-usage=↑\d.* list .* · children 2$/);
  assert.doesNotThrow(() => f.update("s", { mode: "tui", ui: { setStatus: () => { throw new Error("x"); } } }, MSG, { enabled: true, isChild: true, children: 0 }));
});

test("totals accumulate across messages even while the footer is off", () => {
  const calls: string[] = [];
  const f = new UsageFooter();
  const ctx = { mode: "tui", ui: { setStatus: (_k: string, v: string | undefined) => calls.push(String(v)) } };
  f.update("s", ctx, MSG, { enabled: false, isChild: true, children: 0 });
  f.update("s", ctx, MSG, { enabled: true, isChild: true, children: 0 });
  assert.match(calls[0], /\$1\.80 list/);
});
