import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAX_DOT_CHECKS, dotChecks } from "../prdots.ts";
import { LiveState, liveDir } from "../livestate.ts";
import type { LiveDot } from "../livestate.ts";
import { pollWatchBatch } from "../prwatch.ts";
import type { PrKey } from "../prtrack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchPoll } from "../prwatch.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { ran, rig, url } from "./_prrig.ts";

const view = (failed: string[], running: string[], passed: string[], missing: string[] = []) => ({
  failed,
  running,
  missing,
  passed,
  counts: { failed: failed.length, running: running.length, missing: missing.length, passed: passed.length },
});

test("dotChecks: failing first, then running (missing counts as running), then green", () => {
  assert.deepEqual(dotChecks(view(["f"], ["r"], ["a", "b"], ["m"])), {
    checks: [
      { name: "f", state: "fail" },
      { name: "r", state: "run" },
      { name: "m", state: "run" },
      { name: "a", state: "ok" },
      { name: "b", state: "ok" },
    ],
  });
});

test("dotChecks: no checks gives nothing; above the cap, or with a cut name list, counts", () => {
  assert.deepEqual(dotChecks(view([], [], [])), {});
  const many = Array.from({ length: MAX_DOT_CHECKS + 1 }, (_, i) => `c${i}`);
  assert.deepEqual(dotChecks(view([], [], many)), { counts: { fail: 0, run: 0, ok: MAX_DOT_CHECKS + 1 } });
  const cut = { ...view([], [], ["a"]), counts: { failed: 0, running: 0, missing: 0, passed: 3 } };
  assert.deepEqual(dotChecks(cut), { counts: { fail: 0, run: 0, ok: 3 } });
});

const entry = (n: number, checks: Record<string, unknown>) => ({ repo: "acme/app", number: n, url: url("acme/app", n), title: "t", state: "open", draft: false, mergeable: "mergeable", reviewDecision: "approved", headRefName: `b${n}`, checks });

test("a tracked PR's dot carries the checks of its pr_batch answer, state stays the overall value", async () => {
  const h = rig({ branch: "" });
  await h.d.onBash("git push origin feat", " * [new branch]      feat -> feat", true, "/w");
  h.state.handle = (c) => {
    if (c.op === "pr_find") return ran({ prs: [{ number: 3, url: url("acme/app", 3), state: "open", headRefName: "feat" }] });
    if (c.op === "pr_batch") return ran({ prs: [entry(3, { pending: ["build"], failed: [], passed: ["a", "b", "c"], missing: [], counts: { pending: 1, failed: 0, passed: 3, missing: 0 }, truncated: false })], errors: [] });
    return undefined;
  };
  h.d.start();
  await h.fire();
  await h.fire();
  const d = h.d.dots().find((x) => x.n === 3);
  assert.equal(d?.state, "run");
  assert.deepEqual(d?.checks?.map((c) => c.state), ["run", "ok", "ok", "ok"]);
  assert.equal(d?.counts, undefined);
});

test("a PR without checks has neither checks nor counts (the old shape)", async () => {
  const h = rig({ branch: "" });
  await h.d.onBash("git push origin feat", " * [new branch]      feat -> feat", true, "/w");
  h.state.handle = (c) => {
    if (c.op === "pr_find") return ran({ prs: [{ number: 3, url: url("acme/app", 3), state: "open", headRefName: "feat" }] });
    if (c.op === "pr_batch") return ran({ prs: [entry(3, { pending: [], failed: [], passed: [], missing: [], counts: { pending: 0, failed: 0, passed: 0, missing: 0 }, truncated: false })], errors: [] });
    return undefined;
  };
  h.d.start();
  await h.fire();
  await h.fire();
  const d = h.d.dots().find((x) => x.n === 3);
  assert.ok(d);
  assert.equal("checks" in d, false);
  assert.equal("counts" in d, false);
});

function live(dots: LiveDot[]) {
  const agent = mkTestTmp("prck-");
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd: agent, mode: "rpc", env: {} }, () => [], undefined, undefined, undefined, () => dots);
  assert.ok(l);
  l.flush();
  const read = JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8")) as { dots: LiveDot[] };
  l.stop();
  rmTestTmp(agent);
  return read.dots;
}

test("live file: checks, counts and the plain old shape are written; bad entries are dropped; ext dots never carry them", () => {
  const checks = [{ name: "a", state: "fail" as const }, { name: "b", state: "ok" as const }];
  const got = live([
    { n: 1, state: "fail", label: "#1", src: "pr", checks },
    { n: 2, state: "ok", label: "#2", src: "pr", counts: { fail: 0, run: 0, ok: 20 } },
    { n: 3, state: "ok", label: "#3", src: "pr" },
    { n: 4, state: "ok", label: "#4", src: "pr", checks: [{ name: "x", state: "bogus" as never }, { name: 5 as never, state: "ok" }] },
    { n: null, state: "ok", label: "deploy", src: "ext", checks },
  ]);
  assert.deepEqual(got[0].checks, checks);
  assert.deepEqual(got[1].counts, { fail: 0, run: 0, ok: 20 });
  assert.equal("checks" in got[2] || "counts" in got[2], false);
  assert.equal("checks" in got[3] || "counts" in got[3], false);
  assert.equal("checks" in got[4], false);
  assert.deepEqual(got.map((d) => d.state), ["fail", "ok", "ok", "ok", "ok"]);
});

test("live file: more than the cap of checks is cut at the cap", () => {
  const checks = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, state: "ok" as const }));
  assert.equal(live([{ n: 1, state: "ok", label: "#1", src: "pr", checks }])[0].checks?.length, MAX_DOT_CHECKS);
});

// ---------------------------------------------------------------- one pr_batch per host and tick

const A: PrKey = { host: "github.com", repo: "acme/app", n: 1 };
const B: PrKey = { host: "github.com", repo: "acme/app", n: 2 };
const pr = (n: number) => ({ repo: "acme/app", number: n, url: "u", title: "T", state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "t0", runs: [] });

test("pollWatchBatch: two PRs on one host are one pr_batch call, answers matched by number", async () => {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const r = async (op: string, args: Record<string, unknown>) => {
    calls.push({ op, args });
    return ran(op === "pr_batch" ? { prs: [pr(2), pr(1)], errors: [] } : { comments: [] });
  };
  const out = await pollWatchBatch(r as never, [{ key: A, seen: { updatedAt: "t0" } }, { key: B, seen: { updatedAt: "t0" } }]);
  assert.deepEqual(calls.map((c) => c.op), ["pr_batch"]);
  assert.deepEqual(calls[0].args.prs, [{ repo: "acme/app", n: 1 }, { repo: "acme/app", n: 2 }]);
  assert.equal(calls[0].args.watch, true);
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => "snap" in o));
});

test("pollWatchBatch: one PR missing is gone, the other still answers; a number-only key falls back to pr_status", async () => {
  const r = async (op: string, args: Record<string, unknown>) => {
    if (op === "pr_batch") return ran({ prs: [pr(1)], errors: [{ repo: "acme/app", number: 2, kind: "pr_not_found" }] });
    if (op === "pr_status") return ran({ state: "open", mergeable: "mergeable", headSha: "h", baseRef: "main", updatedAt: "t0" });
    if (op === "pr_checks") return ran({ failed: [], pending: [], passed: [] });
    return ran({ comments: [] });
  };
  const out = await pollWatchBatch(r as never, [{ key: A, seen: { updatedAt: "t0" } }, { key: B, seen: { updatedAt: "t0" } }, { key: { host: "", repo: "", n: 9 }, seen: { updatedAt: "t0" } }]);
  assert.ok("snap" in out[0]);
  assert.deepEqual(out[1], { gone: true });
  assert.ok("snap" in out[2]);
});

test("PrWatches: two watched PRs on one host give one poll call per tick", async () => {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  const batches: number[][] = [];
  const snap = { state: "open" as const, mergeable: "mergeable" as const, head: "h", base: "main", updatedAt: "t0", runs: [], status: {} };
  const w = new PrWatches({
    poll: async () => assert.fail("single poll"),
    pollMany: async (items) => (batches.push(items.map((i) => i.key.n)), items.map((): WatchPoll => ({ snap }))),
    send: () => undefined,
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers: fake,
  });
  w.start(A, snap);
  w.start(B, snap);
  for (let tick = 0; tick < 3; tick++) {
    const t = [...timers].reverse().find((x) => x.live);
    assert.ok(t);
    t.live = false;
    t.fn();
    await new Promise((res) => setImmediate(res));
    assert.equal(batches.length, tick + 1, "one call per tick");
    assert.deepEqual(batches[tick].sort(), [1, 2]);
    assert.equal(timers.filter((x) => x.live).length, 2, "both watches re-armed");
  }
  assert.equal(w.size(), 2);
  w.clear();
});
