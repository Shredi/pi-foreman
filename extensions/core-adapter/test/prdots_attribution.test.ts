import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prtrack.ts";
import { ran, rig, url } from "./_prrig.ts";

const entry = (n: number, over: Record<string, unknown> = {}) => ({
  repo: "acme/app",
  number: n,
  url: url("acme/app", n),
  title: `title ${n}`,
  state: "open",
  draft: false,
  mergeable: "mergeable",
  reviewDecision: "approved",
  headRefName: `b${n}`,
  checks: { pending: [], failed: [], passed: ["a"], missing: [], counts: { pending: 0, failed: 0, passed: 1, missing: 0 }, truncated: false },
  ...over,
});
const answerBatch = (h: ReturnType<typeof rig>, over: (n: number) => Record<string, unknown> = () => ({})) => {
  h.state.handle = (c) => (c.op === "pr_batch" ? ran({ prs: (c.args.prs as { n: number }[]).map((p) => entry(p.n, over(p.n))), errors: [] }) : undefined);
};
const k = (n: number): PrKey => ({ host: "github.com", repo: "acme/app", n });
const flush = () => new Promise((r) => setImmediate(r));

test("text that quotes a PR does not register: bash output with PR #73 or a PR URL", async () => {
  const h = rig({ branch: "" });
  answerBatch(h);
  await h.d.onBash("cat notes.txt", `see PR #73 and ${url("acme/app", 73)}`, true, "/w");
  await h.d.onBash("echo hi", `${url("acme/other", 74)} ${url("acme/app", 75, "git.example.org")}`, true, "/w");
  h.d.start();
  await h.fire();
  assert.deepEqual(h.tracks, []);
  assert.deepEqual(h.d.dots(), []);
  assert.equal(h.callsOf("pr_batch").length, 0);
});

test("commands acted on do not register: gh pr merge/comment/view 73, glab mr note, gh api writes", async () => {
  const h = rig({ branch: "" });
  answerBatch(h);
  for (const c of ["gh pr merge 73 --squash", "gh pr comment 73 -b hi", "gh pr view 73", `gh pr close ${url("acme/app", 73)}`, "glab mr note 73 -m hi", "gh api -X POST repos/acme/app/issues/73/comments -f body=x"]) await h.d.onBash(c, "", true, "/w");
  h.d.start();
  await h.fire();
  assert.deepEqual(h.tracks, []);
  assert.deepEqual(h.d.dots(), []);
});

test("the session's own PRs register: pr_create, pr_track, pr_watch", async () => {
  const h = rig({ branch: "", watched: () => [k(3)] });
  answerBatch(h);
  h.d.onCreated(1, url("acme/app", 1));
  h.d.trackTool(k(2));
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => d.n).sort(), [1, 2, 3]);
  assert.deepEqual(h.tracks.map((t) => t.path).sort(), ["create", "tool", "watch"]);
});

test("a pushed branch registers its PR (pr_find by head)", async () => {
  const h = rig({ branch: "" });
  answerBatch(h);
  h.state.handle = ((prev) => (c: Parameters<typeof prev>[0]) =>
    c.op === "pr_find" && c.args.head === "feat" ? ran({ prs: [{ number: 9, url: url("acme/app", 9), state: "open", headRefName: "feat" }] }) : prev(c))(h.state.handle);
  await h.d.onBash("git push -u origin feat", " * [new branch]      feat -> feat", true, "/w");
  await flush();
  h.d.start();
  await h.fire();
  assert.deepEqual(h.tracks.map((t) => t.path), ["push"]);
  assert.deepEqual(h.d.dots().map((d) => d.n), [9]);
});

test("the author search ignores a same-named branch in another repository", async () => {
  const h = rig({ branch: "" });
  answerBatch(h);
  await h.d.onBash("git push origin topic", " * [new branch]      topic -> topic", true, "/w");
  await flush();
  const hits = [
    { number: 1, url: url("acme/other", 1), state: "open", headRefName: "topic" },
    { number: 2, url: url("acme/app", 2), state: "open", headRefName: "topic" },
  ];
  const prev = h.state.handle;
  h.state.handle = (c) => (c.op === "pr_find" && c.args.author === "@me" ? ran({ prs: hits }) : prev(c));
  h.d.start();
  await h.fire();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => d.n), [2]);
});

test("a merged PR leaves the dots at the next poll", async () => {
  const h = rig({ branch: "" });
  h.d.onCreated(7, url("acme/app", 7));
  answerBatch(h);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => d.n), [7]);
  answerBatch(h, () => ({ state: "merged" }));
  await h.fire();
  assert.deepEqual(h.d.dots(), []);
});

test("a watch keyed with an empty repository is deleted when its PR is merged", async () => {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  const snap = (state: "open" | "merged"): WatchSnapshot => ({ state, mergeable: "mergeable", head: "abcdef0", base: "main", updatedAt: "t", runs: [], status: {} });
  let state: "open" | "merged" = "open";
  const w = new PrWatches({ poll: async () => ({ snap: snap(state) }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0, timers: fake });
  const key: PrKey = { host: "", repo: "", n: 7 };
  assert.equal(w.reserve(key), true);
  w.start(key, snap("open"));
  assert.equal(w.size(), 1);
  state = "merged";
  [...timers].reverse().find((t) => t.live)?.fn();
  await flush();
  assert.equal(w.size(), 0);
  assert.equal(w.lastSnapshot(key), null);
});
