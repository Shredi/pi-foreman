import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aggregate, appendUsage, BINDINGS_ENV, bindLaunch, causeOfCustom, causeOfInput, filterWorkspace, formatSummary, launchKind, parseLines, readBinding, readUsage, recordUsageLaunch, singleLaunchRole, usageFile, usageLine } from "../usage.ts";
import type { LaunchBinding, LineContext } from "../usage.ts";

const MSG = {
  role: "assistant",
  provider: "p1",
  model: "mid",
  stopReason: "error",
  usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05, total: 0.36 } },
};
const CTX: LineContext = { workspace: "/w/a", foremanSession: "fs1", role: "builder", launchId: "L1", kind: "first" };

test("usage line: all fields, four token kinds and four cost parts kept apart", () => {
  const l = usageLine(CTX, MSG, new Date(0));
  assert.deepEqual(l, {
    ts: "1970-01-01T00:00:00.000Z", workspace: "/w/a", foremanSession: "fs1", role: "builder", provider: "p1", model: "mid",
    launchId: "L1", kind: "first", stopReason: "error", input: 10, cacheRead: 3, cacheWrite: 2, output: 5,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05, total: 0.36 },
  });
  assert.deepEqual(usageLine(CTX, { role: "assistant" }, new Date(0)).cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("usage file: appended one line per call, never rewritten; IO errors return false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-usage-"));
  const file = usageFile(dir, "fs/1");
  assert.equal(file, path.join(dir, "pi-foreman", "state", "usage", "fs1.jsonl"));
  assert.ok(appendUsage(file, usageLine(CTX, MSG)));
  fs.appendFileSync(file, "{torn");
  fs.appendFileSync(file, "\n");
  assert.ok(appendUsage(file, usageLine({ ...CTX, role: "foreman", launchId: null, kind: "foreman" }, MSG)));
  const lines = parseLines(fs.readFileSync(file, "utf8"));
  assert.deepEqual(lines.map((l) => l.role), ["builder", "foreman"]);
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "");
  assert.equal(appendUsage(path.join(blocker, "x", "y.jsonl"), usageLine(CTX, MSG)), false);
});

test("launch binding: recorded with kind first/fallback/explicit, written into a single launch, read back by the child", () => {
  const reg = new Map<string, LaunchBinding>();
  const b = recordUsageLaunch(reg, { foremanSession: "fs1", workspace: "/w/a", role: "builder", model: "p1/mid:high", activeProvider: "p1" });
  assert.equal(b.kind, "first");
  assert.equal(reg.get(b.launchId), b);
  assert.equal(recordUsageLaunch(reg, { foremanSession: "fs1", workspace: "/w/a", role: "builder", model: "p2/mid", activeProvider: "p1" }).kind, "fallback");
  assert.equal(recordUsageLaunch(reg, { foremanSession: "fs1", workspace: "/w/a", role: "builder", model: "p1/mid", kind: "revision" }).kind, "revision");
  assert.equal(launchKind(null, "p1"), "first");
  assert.equal(reg.size, 3);

  const input: Record<string, unknown> = { agent: "builder", task: "t", extensionBindings: { "other/1": { x: 1 }, "pi-foreman/1": { role: "forged" } } };
  assert.equal(singleLaunchRole(input), "builder");
  assert.equal(singleLaunchRole({ tasks: [{ agent: "builder" }] }), null);
  assert.equal(singleLaunchRole({ action: "resume", agent: "builder" }), null);
  bindLaunch(input, b);
  const eb = input.extensionBindings as Record<string, unknown>;
  assert.deepEqual(eb["other/1"], { x: 1 });
  assert.deepEqual(readBinding({ [BINDINGS_ENV]: JSON.stringify(eb) }), b);
  assert.equal(readBinding({}), null);
  assert.equal(readBinding({ [BINDINGS_ENV]: "{bad" }), null);
});

test("aggregate: per role and per model, token kinds and cost parts separate, launches by kind; workspace filter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-usage-"));
  const fm: LineContext = { workspace: "/w/a", foremanSession: "fs1", role: "foreman", launchId: null, kind: "foreman" };
  appendUsage(usageFile(dir, "fs1"), usageLine(fm, MSG));
  appendUsage(usageFile(dir, "fs1"), usageLine(fm, MSG));
  appendUsage(usageFile(dir, "fs1"), usageLine(CTX, MSG));
  appendUsage(usageFile(dir, "fs1"), usageLine({ ...CTX, launchId: "L2", kind: "fallback" }, { ...MSG, provider: "p2" }));
  appendUsage(usageFile(dir, "fs2"), usageLine({ ...fm, foremanSession: "fs2", workspace: "/w/b" }, MSG));

  const sum = aggregate(readUsage(dir, { session: "fs1" }));
  assert.equal(sum.total.calls, 4);
  assert.deepEqual([...sum.byRole.keys()].sort(), ["builder", "foreman"]);
  const f = sum.byRole.get("foreman")!;
  assert.deepEqual([f.calls, f.input, f.cacheRead, f.cacheWrite, f.output], [2, 20, 6, 4, 10]);
  assert.ok(Math.abs(f.cost.cacheWrite - 0.1) < 1e-9 && Math.abs(f.cost.total - 0.72) < 1e-9);
  assert.deepEqual([...sum.byModel.keys()].sort(), ["p1/mid", "p2/mid"]);
  assert.deepEqual(Object.fromEntries(sum.byKind), { foreman: { launches: 1, calls: 2 }, first: { launches: 1, calls: 1 }, fallback: { launches: 1, calls: 1 } });
  const text = formatSummary(sum, "t");
  assert.match(text, /cacheWrite/);
  assert.match(text, /fallback\s+1 launch/);

  assert.equal(readUsage(dir, { workspace: "/w/b" }).length, 1);
  assert.equal(readUsage(dir, { workspace: "/w/a" }).length, 4);
  assert.equal(filterWorkspace(readUsage(dir, { workspace: "/w/a" }), "/w/c").length, 0);
  assert.match(formatSummary(aggregate([]), "t"), /no usage recorded/);
});

test("turn cause: input source and pi-subagents message types", () => {
  assert.equal(causeOfInput("interactive"), "user");
  assert.equal(causeOfInput("rpc"), "user");
  assert.equal(causeOfInput("extension"), "other");
  assert.equal(causeOfCustom("subagent-notify"), "child");
  assert.equal(causeOfCustom("subagent_supervisor_request"), "intercom");
  assert.equal(causeOfCustom("pi-foreman-stop-gate"), null);
});
