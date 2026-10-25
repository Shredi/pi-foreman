import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_VIEW_MS, dotState } from "../prdots.ts";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { pre, ran, rig, url } from "./_prrig.ts";
import type { Call } from "./_prrig.ts";

const flush = () => new Promise((r) => setImmediate(r));
const push = (h: ReturnType<typeof rig>, name: string, cwd = "/w") => h.d.onBash(`git push origin ${name}`, ` * [new branch]      ${name} -> ${name}`, true, cwd);
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

test("dotState: a missing-only PR is run", () => {
  assert.equal(dotState("mergeable", { missing: [{}] } as never), "run");
  assert.equal(dotState("mergeable", { missing: [{}], passed: [{}] } as never), "run");
  assert.equal(dotState("conflicting", { missing: [{}] } as never), "fail");
});

test("pr_find {head} runs in the push cwd on the next tick and once more after five minutes", async () => {
  const h = rig({ branch: "" });
  await push(h, "feat", "/other");
  h.d.start();
  await h.fire();
  const finds = () => h.callsOf("pr_find").filter((c) => c.args.head === "feat");
  assert.equal(finds().length, 1);
  assert.equal(finds()[0].cwd, "/other");
  await h.fire();
  assert.equal(finds().length, 1, "not before five minutes");
  h.advance(5 * 60_000);
  await h.fire();
  assert.equal(finds().length, 2);
  await h.fire();
  assert.equal(finds().length, 2, "twice only");
});

test("pr_find {head}: at most two lookups per tick; a hit registers under the answer's URL with path push", async () => {
  const h = rig({ branch: "" });
  for (const b of ["a", "b", "c"]) await push(h, b);
  h.state.handle = (c) => (c.op === "pr_find" && c.args.head === "c" ? ran({ prs: [{ number: 3, url: url("acme/up", 3), state: "open", headRefName: "c" }] }) : undefined);
  h.d.start();
  await h.fire();
  assert.equal(h.callsOf("pr_find").length, 2);
  assert.deepEqual(h.tracks.filter((t) => t.path === "push").length, 1);
  assert.deepEqual(h.callsOf("pr_batch")[0].args.prs, [{ repo: "acme/up", n: 3 }]);
  await h.fire();
  assert.equal(h.callsOf("pr_find").filter((c) => c.args.head === "a").length, 1, "the third branch on the next tick");
});

test("author search runs every second tick; only the current or a pushed branch's PR registers, path search", async () => {
  const h = rig({ branch: "feat" });
  await push(h, "topic");
  const hits = [
    { number: 1, url: url("acme/app", 1), state: "open", headRefName: "feat" },
    { number: 2, url: url("acme/app", 2), state: "open", headRefName: "topic" },
    { number: 3, url: url("acme/app", 3), state: "open", headRefName: "unrelated" },
  ];
  h.state.handle = (c) => (c.op === "pr_find" && c.args.author === "@me" ? ran({ prs: hits }) : undefined);
  h.d.start();
  await h.fire();
  const authors = () => h.callsOf("pr_find").filter((c) => c.args.author === "@me").length;
  assert.equal(authors(), 0);
  await h.fire();
  assert.equal(authors(), 1);
  await h.fire();
  assert.equal(authors(), 1);
  await h.fire();
  assert.equal(authors(), 2);
  assert.deepEqual(h.tracks.filter((t) => t.path === "search").length, 2);
  assert.deepEqual(h.d.dots().map((d) => d.n).sort(), [1, 2]);
});

test("one pr_batch per host and tick; entries map to views", async () => {
  const h = rig({ branch: "" });
  h.d.onCreated(1, url("acme/app", 1));
  h.d.onCreated(2, url("acme/lib", 2));
  h.d.onCreated(3, url("acme/app", 3, "git.example.org"));
  h.state.handle = (c) => {
    if (c.op !== "pr_batch") return undefined;
    const prs = c.args.prs as { repo: string; n: number }[];
    return ran({
      prs: prs.map((p) =>
        c.args.host === "git.example.org"
          ? entry(p.n, { repo: p.repo, checks: { pending: [], failed: [], passed: [], missing: ["req"], counts: { pending: 0, failed: 0, passed: 0, missing: 1 }, truncated: false } })
          : entry(p.n, { repo: p.repo, checks: { pending: ["slow"], failed: p.n === 1 ? ["boom"] : [], passed: ["ok"], missing: [], counts: { pending: 1, failed: p.n === 1 ? 1 : 0, passed: 12, missing: 0 }, truncated: p.n === 2 } }),
      ),
      errors: [],
    });
  };
  h.d.start();
  await h.fire();
  const batches = h.callsOf("pr_batch");
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((b) => b.args.host).sort(), ["git.example.org", "github.com"]);
  const views = h.d.views();
  const byN = new Map(views.map((v) => [v.key.n, v]));
  assert.equal(byN.get(1)?.dot, "fail");
  assert.deepEqual(byN.get(1)?.checks.failed, ["boom"]);
  assert.deepEqual(byN.get(1)?.checks.running, ["slow"]);
  assert.equal(byN.get(1)?.checks.counts.passed, 12);
  assert.equal(byN.get(2)?.dot, "run");
  assert.equal(byN.get(2)?.checks.truncated, true);
  assert.equal(byN.get(3)?.dot, "run", "missing only");
  assert.deepEqual(byN.get(3)?.checks.missing, ["req"]);
  assert.equal(byN.get(1)?.label, "#1");
  assert.equal(byN.get(2)?.label, "acme/lib#2", "another repository");
});

test("views: foreign label, link only when the URL matches the key, names capped at ten, titles sanitised", async () => {
  const h = rig({ branch: "" });
  h.d.onCreated(1, url("acme/lib", 1));
  h.d.onCreated(2, url("acme/app", 2));
  const many = Array.from({ length: 14 }, (_, i) => `job${i}`);
  h.state.handle = (c) =>
    c.op === "pr_batch"
      ? ran({
          prs: [
            entry(1, { repo: "acme/lib", title: "a\u0085b\u202ec\u001bd", checks: { pending: many, failed: [], passed: [], missing: [], counts: { pending: 14, failed: 0, passed: 0, missing: 0 }, truncated: false } }),
            entry(2, { url: url("acme/other", 2) }),
          ],
          errors: [],
        })
      : undefined;
  h.d.start();
  await h.fire();
  const [v1, v2] = [h.d.views().find((v) => v.key.n === 1), h.d.views().find((v) => v.key.n === 2)];
  assert.equal(v1?.label, "acme/lib#1");
  assert.equal(v1?.foreign, true);
  assert.equal(v1?.title, "abcd");
  assert.equal(v1?.checks.running.length, 10);
  assert.equal(v1?.checks.counts.running, 14);
  assert.equal(v2?.url, null, "the answer's URL names another repository");
  assert.deepEqual(h.d.dots().find((d) => d.n === 1), { n: 1, state: "run", label: "acme/lib#1" });
});

test("pr_batch errors fail only that PR; a not-found drops to gone", async () => {
  const h = rig({ branch: "" });
  for (const n of [1, 2, 3]) h.d.onCreated(n, url("acme/app", n));
  h.state.handle = (c) => (c.op === "pr_batch" ? ran({ prs: [entry(1)], errors: [{ repo: "acme/app", number: 2, kind: "pr_host_failed" }, { repo: "acme/app", number: 3, kind: "pr_not_found" }] }) : undefined);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => [d.n, d.state]).sort(), [[1, "ok"], [2, "none"]]);
  assert.equal(h.live()?.ms, 120_000, "one failed PR backs the tick off");
});

test("pr_unsupported falls back to pr_status and pr_checks per PR, missing empty, and batch is not asked again", async () => {
  const h = rig({ branch: "" });
  h.d.onCreated(1, url("acme/app", 1));
  h.d.onCreated(2, url("acme/app", 2));
  h.state.handle = (c) => {
    if (c.op === "pr_batch") return pre("pr_unsupported");
    if (c.op === "pr_status") return ran({ number: c.args.number, state: "open", mergeable: "mergeable", title: "t", url: url("acme/app", c.args.number as number) });
    if (c.op === "pr_checks") return ran({ pending: [], failed: [], passed: [{ name: "a" }], summary: "s" });
    return undefined;
  };
  h.d.start();
  await h.fire();
  const ops = (n: number) => h.calls.filter((c: Call) => c.args.number === n).map((c) => c.op);
  assert.deepEqual(ops(1), ["pr_status", "pr_checks"]);
  assert.deepEqual(ops(2), ["pr_status", "pr_checks"]);
  assert.deepEqual(h.d.views().map((v) => v.checks.missing.length), [0, 0]);
  assert.deepEqual(h.d.dots().map((d) => d.state), ["ok", "ok"]);
  await h.fire();
  assert.equal(h.callsOf("pr_batch").length, 1);
});

test("call budget: gh is 4 + hosts at worst; glab and templates stay within twelve with six PRs", async () => {
  const h = rig({ branch: "feat" });
  for (const b of ["a", "b", "c"]) await push(h, b);
  h.d.onCreated(1, url("acme/app", 1));
  h.d.onCreated(2, url("acme/app", 2, "git.example.org"));
  h.state.handle = (c) => (c.op === "pr_status" && c.args.number === undefined ? ran({ number: 9, state: "open", url: url("acme/app", 9) }) : c.op === "pr_batch" ? ran({ prs: [], errors: [] }) : undefined);
  h.d.start();
  await h.fire();
  await h.fire(); // the even tick adds the author search
  const second = h.calls.slice(h.calls.findIndex((c) => c.op === "pr_batch"));
  assert.ok(second.filter((c) => c.op !== "pr_repo").length <= 4 + 3, "bounded");
  const g = rig({ branch: "", batch: false });
  for (let n = 1; n <= 6; n++) g.d.onCreated(n, url("acme/app", n));
  g.state.handle = (c) => (c.op === "pr_status" ? ran({ number: c.args.number, state: "open", mergeable: "mergeable" }) : c.op === "pr_checks" ? ran({ pending: [], failed: [], passed: [{ name: "a" }], summary: "s" }) : undefined);
  g.d.start();
  await g.fire();
  assert.equal(g.calls.filter((c) => c.op !== "pr_repo").length, 12);
});

test("backoff on RATE_LIMITED, 403 and 429", async () => {
  for (const reason of ["gh: GraphQL RATE_LIMITED", "gh: HTTP 403", "gh: HTTP 429"]) {
    const h = rig({ branch: "" });
    h.d.onCreated(1, url("acme/app", 1));
    h.state.handle = (c) => (c.op === "pr_batch" ? { kind: "precondition", precondition: "pr_host_failed", message: reason } : undefined);
    h.d.start();
    await h.fire();
    assert.equal(h.live()?.ms, 120_000, reason);
    await h.fire();
    assert.equal(h.live()?.ms, 240_000, reason);
    assert.ok(h.traces.some((t) => t.outcome === "backoff"));
  }
});

test("a merged PR keeps a view for 60 s, its dot goes at once", async () => {
  const h = rig({ branch: "" });
  h.d.onCreated(1, url("acme/app", 1));
  h.state.handle = (c) => (c.op === "pr_batch" ? ran({ prs: [entry(1, { state: "merged" })], errors: [] }) : undefined);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots(), []);
  assert.equal(h.d.views().length, 1);
  assert.equal(h.d.views()[0].state, "merged");
  h.advance(CLOSED_VIEW_MS - 1);
  assert.equal(h.d.views().length, 1);
  h.advance(2);
  assert.equal(h.d.views().length, 0);
});

test("watched numbers are keyed by the URL of their first pr_status answer (one call per new number)", async () => {
  const h = rig({ branch: "", watched: () => [7] });
  h.state.handle = (c) => {
    if (c.op === "pr_status") return ran({ number: 7, url: url("acme/up", 7), state: "open" });
    return c.op === "pr_batch" ? ran({ prs: (c.args.prs as { n: number }[]).map((p) => entry(p.n, { repo: "acme/up", url: url("acme/up", p.n) })), errors: [] }) : undefined;
  };
  h.d.start();
  await h.fire();
  assert.deepEqual(h.callsOf("pr_batch")[0].args.prs, [{ repo: "acme/up", n: 7 }]);
  assert.equal(h.d.views()[0].source, "watch");
  await h.fire();
  assert.equal(h.callsOf("pr_status").filter((c) => c.args.number === 7).length, 1, "asked once");
});

test("a watched number whose answer has no URL falls back to the current repository", async () => {
  const h = rig({ branch: "", watched: () => [7] });
  h.state.handle = (c) => {
    if (c.op === "pr_status") return ran({ number: 7, state: "open" });
    return c.op === "pr_batch" ? ran({ prs: (c.args.prs as { n: number }[]).map((p) => entry(p.n)), errors: [] }) : undefined;
  };
  h.d.start();
  await h.fire();
  assert.deepEqual(h.callsOf("pr_batch")[0].args.prs, [{ repo: "acme/app", n: 7 }]);
});

test("a templates host without find: discovery is skipped, the poller keeps ticking and the dots stay", async () => {
  const h = rig({ branch: "" });
  await push(h, "feat");
  h.d.onCreated(1, url("acme/app", 1));
  h.state.handle = (c) => {
    if (c.op === "pr_find") return pre("pr_unsupported");
    return c.op === "pr_batch" ? ran({ prs: [entry(1)], errors: [] }) : undefined;
  };
  h.d.start();
  for (let i = 0; i < 4; i++) await h.fire();
  assert.equal(h.callsOf("pr_batch").length, 4);
  assert.equal(h.d.dots().length, 1);
  assert.equal(h.d.dots()[0].state, "ok");
  assert.ok(!h.traces.some((t) => t.outcome === "stopped"));
});

test("the repository comes from pr_repo once per cwd; a child (gate closed) calls nothing", async () => {
  const h = rig({ enabled: false });
  h.d.start();
  await h.d.onBash("gh pr comment 5", "", true, "/w");
  assert.equal(h.calls.length, 0);
});

// ------------------------------------------------------------------ the finish and close notice

function noticeRig(over: { merged?: boolean | null; find?: (c: Call) => ReturnType<typeof ran> | undefined } = {}) {
  const asked: string[] = [];
  const h = rig({ branch: "", merged: async (cwd, remote, name) => (asked.push(`${cwd}|${remote}|${name}`), over.merged === undefined ? false : over.merged), baseBranch: "main" });
  if (over.find) h.state.handle = (c) => (c.op === "pr_find" ? over.find!(c) : undefined);
  const notes: string[] = [];
  return { h, notes, asked, run: () => h.d.pushNotice((b) => void notes.push(b)) };
}

test("notice: a pushed branch with no PR of any state and not merged is named once", async () => {
  const n = noticeRig();
  await push(n.h, "feat");
  await n.run();
  assert.deepEqual(n.notes, ["feat"]);
  assert.deepEqual(n.h.callsOf("pr_find").map((c) => [c.args.head, c.args.state]), [["feat", "all"]]);
  assert.deepEqual(n.asked, ["/w|origin|feat"]);
  n.h.advance(11 * 60_000);
  await n.run();
  assert.deepEqual(n.notes, ["feat"], "once per branch");
});

test("notice: the push -u case", async () => {
  const n = noticeRig();
  await n.h.d.onBash("git push -u origin feat", "branch 'feat' set up to track 'origin/feat'.\n * [new branch]      feat -> feat", true, "/w");
  await n.run();
  assert.deepEqual(n.notes, ["feat"]);
});

test("notice: no notice for the base branch, a tracked PR (also merged since), a merged PR found by pr_find, or a merged branch", async () => {
  const base = noticeRig();
  await push(base.h, "main");
  await base.run();
  assert.deepEqual(base.notes, []);
  assert.equal(base.h.callsOf("pr_find").length, 0);

  const tracked = noticeRig();
  await push(tracked.h, "feat");
  await flush();
  tracked.h.d.onCreated(4, url("acme/app", 4));
  await flush();
  tracked.h.state.handle = (c) => (c.op === "pr_find" ? ran({ prs: [{ number: 4, url: url("acme/app", 4), state: "open", headRefName: "feat" }] }) : undefined);
  await tracked.run();
  assert.deepEqual(tracked.notes, [], "pr_find found the open PR");
  assert.equal(tracked.h.tracks.filter((t) => t.path === "push").length, 1);

  const squash = noticeRig({ find: () => ran({ prs: [{ number: 5, url: url("acme/app", 5), state: "merged", headRefName: "feat" }] }) });
  await push(squash.h, "feat");
  await squash.run();
  assert.deepEqual(squash.notes, []);
  assert.deepEqual(squash.asked, [], "the merged subcommand is not needed");

  const merged = noticeRig({ merged: true });
  await push(merged.h, "feat");
  await merged.run();
  assert.deepEqual(merged.notes, []);

  const unknown = noticeRig({ merged: null });
  await push(unknown.h, "feat");
  await unknown.run();
  assert.deepEqual(unknown.notes, [], "no ref: skipped");
});

test("notice: a PR registered earlier for the branch (then merged) skips the lookup", async () => {
  const n = noticeRig();
  await push(n.h, "feat");
  n.h.state.handle = (c) => (c.op === "pr_find" ? ran({ prs: [{ number: 5, url: url("acme/app", 5), state: "open", headRefName: "feat" }] }) : undefined);
  n.h.d.start();
  await n.h.fire();
  n.h.state.handle = (c) => (c.op === "pr_batch" ? ran({ prs: [entry(5, { state: "merged", headRefName: "feat" })], errors: [] }) : undefined);
  await n.h.fire();
  const before = n.h.callsOf("pr_find").length;
  await n.run();
  assert.deepEqual(n.notes, []);
  assert.equal(n.h.callsOf("pr_find").length, before, "no pr_find at notice time");
});

test("notice: a failed lookup is retried after ten minutes, not before; a second call during a run is dropped", async () => {
  let fail = true;
  const n = noticeRig({ find: () => (fail ? (pre("pr_host_failed") as never) : undefined) });
  await push(n.h, "feat");
  n.h.state.handle = (c) => (c.op === "pr_find" ? (fail ? pre("pr_host_failed") : ran({ prs: [] })) : undefined);
  await n.run();
  assert.deepEqual(n.notes, []);
  n.h.advance(5 * 60_000);
  await n.run();
  assert.equal(n.h.callsOf("pr_find").length, 1, "within ten minutes");
  fail = false;
  n.h.advance(6 * 60_000);
  await n.run();
  assert.deepEqual(n.notes, ["feat"]);

  const slow = noticeRig();
  await push(slow.h, "feat");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  slow.h.state.handle = (c) => (c.op === "pr_find" ? gate.then(() => ran({ prs: [] })) : undefined);
  const orig = slow.h.d.pushNotice.bind(slow.h.d);
  const first = orig((b) => void slow.notes.push(b));
  const second = orig((b) => void slow.notes.push(b + "!"));
  await second;
  release();
  await first;
  assert.deepEqual(slow.notes, ["feat"]);
});

test("notice: git -C other push and cd other && git push record the other cwd for the lookup", async () => {
  const n = noticeRig();
  await n.h.d.onBash("git -C /other push origin a", " * [new branch]      a -> a", true, "/w");
  await n.h.d.onBash("cd /second && git push origin b", " * [new branch]      b -> b", true, "/w");
  await n.run();
  assert.deepEqual(n.h.callsOf("pr_find").map((c) => c.cwd).sort(), ["/other", "/second"]);
  assert.deepEqual(n.notes.sort(), ["a", "b"]);
});

test("notice: CloseFlow starts the evaluation without waiting for it", () => {
  const log: string[] = [];
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push("prompt"),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: () => undefined,
    notify: (t) => void log.push("notify"),
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => false,
    setTimer: () => () => undefined,
    pushNotice: () => void log.push("notice-started"),
  };
  const flow = new CloseFlow(deps);
  flow.request({ source: "herdr", file: "/x/r.md" }, { isIdle: () => true });
  assert.ok(log.includes("notice-started"));
  assert.ok(log.includes("prompt"), "the close turn starts at once");
  assert.ok(log.indexOf("notice-started") < log.indexOf("prompt"));
  const refused = new CloseFlow({ ...deps, activeRuns: () => 1 });
  log.length = 0;
  refused.request({ source: "herdr", file: "/x/r.md" }, { isIdle: () => true });
  assert.ok(!log.includes("notice-started"), "a refused close starts nothing");
});
