import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KeepaliveLog, keepaliveLine } from "../keepalive.ts";
import { aggregate, formatSummary, parseLines, usageLine, type LineContext } from "../usage.ts";
import { UsageFooter } from "../footer.ts";

const CTX: LineContext = { workspace: "/w", foremanSession: "fs1", role: "foreman", launchId: null, kind: "foreman" };
const entry = (id: string, at: string, over: Record<string, unknown> = {}) => ({
  type: "usage",
  kind: "cache_warm",
  id,
  timestamp: at,
  provider: "claude-bridge",
  model: "claude-x",
  usage: { input: 0, output: 1, cacheRead: 50_000, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 } },
  ...over,
});

function tmpFile(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ka-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "usage", "fs1.jsonl");
}

test("sync appends one keepalive line per new entry, dedupes, traces fired", (t) => {
  const file = tmpFile(t);
  const traces: Record<string, unknown>[] = [];
  const log = new KeepaliveLog();
  const entries = [{ type: "message" }, entry("e1", "2026-01-01T00:00:00.000Z"), { type: "usage", kind: "other", id: "x" }];
  const r1 = log.sync({ entries, file, line: CTX, trace: (r) => void traces.push(r) });
  assert.equal(r1.newEntries, 1);
  assert.equal(r1.lastReadAt, Date.parse("2026-01-01T00:00:00.000Z"));
  entries.push(entry("e2", "2026-01-01T00:04:30.000Z"));
  const r2 = log.sync({ entries, file, line: CTX, trace: (r) => void traces.push(r) });
  assert.equal(r2.newEntries, 1);
  assert.equal(log.sync({ entries, file, line: CTX }).newEntries, 0);
  const lines = parseLines(fs.readFileSync(file, "utf8"));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.kind, l.role, l.entryId, l.ts]), [["keepalive", "foreman", "e1", "2026-01-01T00:00:00.000Z"], ["keepalive", "foreman", "e2", "2026-01-01T00:04:30.000Z"]]);
  assert.equal(lines[0].cacheRead, 50_000);
  assert.equal(lines[0].cost.total, 0.015);
  assert.deepEqual(traces, [
    { event: "keepalive", outcome: "fired", cacheRead: 50_000, cacheWrite: 0, cost: 0.015 },
    { event: "keepalive", outcome: "fired", cacheRead: 50_000, cacheWrite: 0, cost: 0.015 },
  ]);
});

test("a resumed session seeds the seen set from the log and does not double-count", (t) => {
  const file = tmpFile(t);
  const entries = [entry("e1", "2026-01-01T00:00:00.000Z")];
  new KeepaliveLog().sync({ entries, file, line: CTX });
  const resumed = new KeepaliveLog();
  entries.push(entry("e2", "2026-01-01T00:05:00.000Z"));
  assert.equal(resumed.sync({ entries, file, line: CTX }).newEntries, 1);
  assert.equal(parseLines(fs.readFileSync(file, "utf8")).length, 2);
});

test("cost: Pi's total when non-zero, else registry rates (bridge at anthropic rates)", () => {
  const registry = { find: (p: string) => (p === "anthropic" ? { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } : undefined) };
  const zero = entry("z", "2026-01-01T00:00:00.000Z", { usage: { input: 0, output: 1, cacheRead: 1_000_000, cacheWrite: 0, cost: { total: 0 } } });
  const priced = keepaliveLine(CTX, zero, registry);
  assert.ok(Math.abs(priced.cost.total - 0.300015) < 1e-9, String(priced.cost.total));
  assert.equal(keepaliveLine(CTX, zero).cost.total, 0, "no registry: unpriced stays 0");
  assert.equal(keepaliveLine(CTX, entry("p", "2026-01-01T00:00:00.000Z"), registry).cost.total, 0.015);
});

test("aggregate excludes keepalive from every total and sums it separately; formatSummary adds one line", () => {
  const turn = usageLine(CTX, { provider: "p", model: "m", usage: { input: 10, output: 5, cost: { total: 0.5 } } });
  const ka = keepaliveLine(CTX, entry("e1", "2026-01-01T00:00:00.000Z"));
  const sum = aggregate([turn, ka, ka]);
  assert.equal(sum.total.calls, 1);
  assert.equal(sum.total.cost.total, 0.5);
  assert.equal(sum.byRole.get("foreman")?.calls, 1);
  assert.deepEqual([...sum.byKind.keys()], ["foreman"]);
  assert.equal(sum.keepalive.calls, 2);
  assert.ok(Math.abs(sum.keepalive.cost.total - 0.03) < 1e-12);
  const text = formatSummary(sum, "T");
  assert.match(text, /^keep-alive: 2 call\(s\), \$0\.0300$/m);
  assert.doesNotMatch(formatSummary(aggregate([turn]), "T"), /keep-alive/);
  assert.match(formatSummary(aggregate([ka]), "T"), /no usage recorded\n\nkeep-alive: 1 call\(s\)/);
});

test("the footer totals do not change for a keep-alive message", () => {
  const f = new UsageFooter();
  const statuses: (string | undefined)[] = [];
  const ctx = { mode: "tui", ui: { setStatus: (_k: string, v: string | undefined) => void statuses.push(v) } };
  const opts = { enabled: true, isChild: false, children: 0 };
  f.update("s", ctx, { provider: "p", model: "m", usage: { input: 100, output: 10, cost: { total: 1 } } }, opts);
  const before = f.totalsOf("s");
  f.update("s", ctx, { kind: "keepalive", provider: "p", model: "m", usage: { input: 0, output: 1, cacheRead: 50_000, cost: { total: 0.015 } } }, opts);
  assert.deepEqual(f.totalsOf("s"), before);
});
