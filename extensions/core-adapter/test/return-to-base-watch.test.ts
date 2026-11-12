// The merged hook of the PR watch: the return-to-base line in the message, the gates (key, child, checkout), the pre-close path and a throwing step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrWatches } from "../prwatch.ts";
import type { PrWatchesDeps, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import { mergedReturn, realGit } from "../returntobase.ts";
import type { MergedReturnDeps } from "../returntobase.ts";
import { storeFromPoll } from "./_storefake.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [], ...o });

function harness(o: { child?: boolean; returnToBase?: PrWatchesDeps["returnToBase"]; fresh?: PrWatchesDeps["fresh"] }) {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  const sent: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const notices: string[] = [];
  const w = new PrWatches({
    storeEntry: storeFromPoll(async () => ({ snap: snap({ state: "merged" }) })),
    send: (msg) => void sent.push(msg.content),
    idle: () => true,
    trace: (r) => void traces.push(r),
    intervalMs: () => 5000,
    now: () => 0,
    timers: fake,
    child: () => o.child ?? false,
    cwd: () => "/some/dir",
    returnToBase: o.returnToBase,
    notice: (t) => void notices.push(t),
    fresh: o.fresh,
  });
  const fire = async () => {
    const t = [...timers].reverse().find((x) => x.live);
    if (t) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { w, sent, traces, notices, fire };
}

const HEADER = /^pi-foreman-pr: PR #7 merged /;

test("merged message: the return line is appended last, the rest of the message is unchanged", async () => {
  const plain = harness({});
  plain.w.start(K, snap());
  await plain.fire();
  const asked: unknown[] = [];
  const h = harness({ returnToBase: async (i) => (asked.push(i), { line: "checkout returned: switched to main", outcome: "returned" }) });
  h.w.start(K, snap());
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0], `${plain.sent[0]}\ncheckout returned: switched to main`);
  assert.match(h.sent[0], HEADER);
  assert.deepEqual(asked, [{ key: K, cwd: "/some/dir" }]);
  assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "return_returned" }, { event: "pr_watch", outcome: "merged" }]);
});

test("merged message: a kept checkout is reported in the line too", async () => {
  const h = harness({ returnToBase: async () => ({ line: "checkout left as it is: tracked changes; commit or stash them", outcome: "kept" }) });
  h.w.start(K, snap());
  await h.fire();
  assert.match(h.sent[0], /\ncheckout left as it is: tracked changes; commit or stash them$/);
  assert.deepEqual(h.traces[0], { event: "pr_watch", outcome: "return_kept" });
});

test("merged message: no line when the step has nothing to say (key off)", async () => {
  const plain = harness({});
  plain.w.start(K, snap());
  await plain.fire();
  const h = harness({ returnToBase: async () => null });
  h.w.start(K, snap());
  await h.fire();
  assert.equal(h.sent[0], plain.sent[0]);
  assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "merged" }]);
});

test("a child session that closes itself on merge never runs the step and gets no line", async () => {
  let calls = 0;
  const h = harness({ child: true, returnToBase: async () => (calls++, { line: "x", outcome: "returned" }) });
  h.w.start(K, snap());
  await h.fire();
  assert.equal(calls, 0);
  assert.doesNotMatch(h.sent[0], /checkout/);
});

test("a throwing step still sends the message and ends the watch, and the line says so", async () => {
  const h = harness({ returnToBase: async () => { throw new Error("boom"); } });
  h.w.start(K, snap());
  await h.fire();
  assert.equal(h.w.size(), 0);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /\ncheckout left as it is: the return to the base branch failed \(boom\)/);
  assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "return_error" }, { event: "pr_watch", outcome: "merged" }]);
});

test("refresh() on a merged PR runs the step and shows the line as a notice, with no message", async () => {
  const h = harness({ fresh: async () => "merged", returnToBase: async () => ({ line: "checkout returned: switched to main", outcome: "returned" }) });
  h.w.start(K, snap());
  await h.w.refresh();
  assert.equal(h.w.size(), 0);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.notices, ["PR #7: checkout returned: switched to main"]);
  assert.deepEqual(h.traces, [{ event: "pr_watch", outcome: "merged" }, { event: "pr_watch", outcome: "return_returned" }]);
});

test("refresh() runs nothing for a closed PR, an open PR or a child session", async () => {
  for (const [state, child] of [["closed", false], ["open", false], ["merged", true]] as const) {
    let calls = 0;
    const h = harness({ child, fresh: async () => state, returnToBase: async () => (calls++, { line: "x", outcome: "returned" }) });
    h.w.start(K, snap());
    await h.w.refresh();
    assert.equal(calls, 0, `${state} child=${child}`);
    assert.deepEqual(h.notices, []);
  }
});

test("refresh(): a throwing step is a notice, not an error", async () => {
  const h = harness({ fresh: async () => "merged", returnToBase: async () => { throw new Error("boom"); } });
  h.w.start(K, snap());
  await h.w.refresh();
  assert.equal(h.w.size(), 0);
  assert.match(h.notices[0], /^PR #7: checkout left as it is: .*\(boom\)/);
});

// ---- mergedReturn: the key and the own-checkout gate, on temp repositories

function repo(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("mergedReturn: with the key off no git runs and there is no line", async () => {
  let git = 0;
  const d: MergedReturnDeps = { enabled: () => false, sessionCwd: () => "/x", status: async () => { throw new Error("no"); }, git: async () => (git++, { ok: true, out: "" }) };
  assert.equal(await mergedReturn(d, { cwd: "/x", number: 1 }), null);
  assert.equal(git, 0);
});

test("mergedReturn: a watch directory in another checkout than the session's changes neither and says so", async () => {
  const root = fs.realpathSync.native(mkTestTmp("pf-return-watch-"));
  try {
    const mine = repo(root, "mine");
    const theirs = repo(root, "theirs");
    const seen: string[][] = [];
    let asked = 0;
    const d: MergedReturnDeps = { enabled: () => true, sessionCwd: () => mine, status: async () => (asked++, { kind: "ran", result: {} }), git: (args, dir) => (seen.push(args), realGit(args, dir)) };
    const r = await mergedReturn(d, { cwd: theirs, number: 1 });
    assert.equal(r?.outcome, "kept");
    assert.match(r?.line ?? "", /other than this session's own, so neither is touched/);
    assert.equal(asked, 0);
    assert.deepEqual(seen.map((a) => a[0]), ["rev-parse", "rev-parse"]);
  } finally {
    rmTestTmp(root);
  }
});

test("mergedReturn: the watch directory below the session's checkout is the same checkout and goes on to the step", async () => {
  const root = fs.realpathSync.native(mkTestTmp("pf-return-watch-"));
  try {
    const mine = repo(root, "mine");
    fs.mkdirSync(path.join(mine, "sub"));
    const d: MergedReturnDeps = { enabled: () => true, sessionCwd: () => mine, status: async () => ({ kind: "ran", result: { state: "open" } }), git: realGit };
    const r = await mergedReturn(d, { cwd: path.join(mine, "sub"), number: 1 });
    assert.equal(r?.outcome, "kept");
    assert.match(r?.line ?? "", /does not report the PR as merged/);
  } finally {
    rmTestTmp(root);
  }
});
