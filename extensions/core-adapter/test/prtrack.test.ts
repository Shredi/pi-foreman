import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PrRegistry, chainSegments, keyString, parsePrUrl, parsePush, parsePushOutput } from "../prtrack.ts";
import type { PrKey } from "../prtrack.ts";
import { pre, ran, rig, url } from "./_prrig.ts";

const k = (n: number, repo = "acme/app", host = "github.com"): PrKey => ({ host, repo, n });
const seg = (command: string) => chainSegments(command);
const flush = () => new Promise((r) => setImmediate(r));

test("parsePrUrl: gh and glab forms, host with port, refusals", () => {
  assert.deepEqual(parsePrUrl("https://github.com/acme/app/pull/12"), k(12));
  assert.deepEqual(parsePrUrl("https://git.example.org/acme/app/-/merge_requests/7"), k(7, "acme/app", "git.example.org"));
  assert.deepEqual(parsePrUrl("https://git.example.org:8443/acme/app/merge_requests/7?x=1"), k(7, "acme/app", "git.example.org:8443"));
  assert.equal(parsePrUrl("http://github.com/acme/app/pull/12"), null);
  assert.equal(parsePrUrl("https://github.com/acme/app/issues/12"), null);
  assert.equal(parsePrUrl("https://github.com/../app/pull/12"), null);
  assert.equal(parsePrUrl("https://github.com/acme/app/pull/0"), null);
  assert.equal(parsePrUrl("https://github.com/acme/app/pull/12345678901"), null);
  assert.equal(parsePrUrl(5), null);
});

test("registry: identity is host, repo and number; the same number in two repos is two PRs", () => {
  const r = new PrRegistry();
  assert.equal(r.register(k(5), "branch").added, true);
  assert.equal(r.register(k(5, "acme/other"), "branch").added, true);
  assert.equal(r.register(k(5, "ACME/App", "GitHub.com"), "branch").added, false, "case-insensitive");
  assert.equal(r.size, 2);
  assert.equal(keyString(k(5, "ACME/App", "GitHub.com")), keyString(k(5)));
});

test("registry: newest first, cap six, the oldest weak entry evicted; first source kept and dup does not move", () => {
  const r = new PrRegistry();
  for (let n = 1; n <= 6; n++) r.register(k(n), "branch");
  assert.deepEqual(r.register(k(7), "branch"), { added: true, evicted: k(1) });
  assert.deepEqual(r.list().map((e) => e.key.n), [7, 6, 5, 4, 3, 2]);
  assert.deepEqual(r.register(k(4), "push"), { added: false, dup: true });
  assert.equal(r.get(k(4))?.source, "branch", "first source kept");
  assert.deepEqual(r.list().map((e) => e.key.n), [7, 6, 5, 4, 3, 2], "a dup does not move");
});

test("registry: a flood of weak registrations never evicts push, create, tool or watch entries", () => {
  const r = new PrRegistry();
  r.register(k(1), "push");
  r.register(k(2), "create");
  r.register(k(3), "tool");
  r.register(k(4), "watch");
  r.register(k(5), "branch");
  r.register(k(6), "branch");
  for (let n = 100; n < 120; n++) r.register(k(n), "branch");
  assert.deepEqual(new Set(r.list().map((e) => e.key.n)), new Set([1, 2, 3, 4, 118, 119]));
  const full = new PrRegistry(2);
  full.register(k(1), "push");
  full.register(k(2), "create");
  assert.deepEqual(full.register(k(3), "branch"), { added: false, skipped: true, reason: "full" });
  assert.deepEqual(full.register(k(4), "watch"), { added: true, evicted: k(1) }, "a protected entry evicts the oldest");
});

test("registry: a repeated create moves to the front; ignored blocks automatic paths and pr_track lifts it; gone keeps the head", () => {
  const r = new PrRegistry();
  r.register(k(1), "create");
  r.register(k(2), "create");
  r.register(k(1), "create");
  assert.deepEqual(r.list().map((e) => e.key.n), [1, 2]);
  r.untrack(k(2));
  assert.equal(r.has(k(2)), false);
  assert.deepEqual(r.register(k(2), "branch"), { added: false, skipped: true, reason: "ignored" });
  assert.equal(r.register(k(2), "tool").added, true);
  assert.equal(r.isIgnored(k(2)), false);
  r.register(k(3), "push", "topic");
  r.markGone(k(3));
  assert.equal(r.knownHead("github.com", "acme/app", "topic"), true);
  assert.equal(r.knownHead("github.com", "acme/other", "topic"), false);
  assert.deepEqual(r.register(k(3), "branch"), { added: false, skipped: true, reason: "gone" });
});

test("chainSegments: a relative second cd resolves against the first, an absolute one replaces it", () => {
  assert.equal(seg("cd a && cd b && git push")[0].cd, "a/b");
  assert.equal(seg("cd a && cd /abs && git push")[0].cd, "/abs");
  assert.equal(seg("cd /abs/ && cd b && git push")[0].cd, "/abs/b");
  assert.equal(seg("cd ~/x && cd b && git push")[0].cdBad, true);
});

test("chainSegments: operators, quotes, redirects, env words and a leading cd", () => {
  const s = seg("cd sub && GH_REPO=acme/x gh pr comment 5 -b 'a && b' 2>&1 | tail -n 3; git status");
  assert.deepEqual(s.map((x) => x.words), [["gh", "pr", "comment", "5", "-b", "a && b"], ["tail", "-n", "3"], ["git", "status"]]);
  assert.equal(s[0].cd, "sub");
  assert.equal(s[0].env.GH_REPO, "acme/x");
  assert.equal(seg("git push")[0].cd, null);
  assert.equal(seg("cd ~/x && git push")[0].cdBad, true);
  assert.equal(seg("cd $DIR && git push")[0].cdBad, true);
  assert.deepEqual(seg("echo a\ngit push origin feat").map((x) => x.words[0]), ["echo", "git"]);
});

test("parsePush: global options, remote, git stash push is not a push", () => {
  assert.deepEqual(parsePush(["git", "push"]), { remote: null, dirs: [], gitDir: false });
  assert.deepEqual(parsePush(["git", "-C", "x", "push", "-u", "up", "feat"]), { remote: "up", dirs: ["x"], gitDir: false });
  assert.deepEqual(parsePush(["git", "-c", "a=b", "--no-pager", "push", "--force-with-lease", "origin"]), { remote: "origin", dirs: [], gitDir: false });
  assert.equal(parsePush(["git", "--git-dir=x", "push"])?.gitDir, true);
  assert.equal(parsePush(["git", "stash", "push"]), null);
  assert.equal(parsePush(["git", "status"]), null);
  assert.equal(parsePush(["gh", "pr", "push"]), null);
});

test("parsePushOutput: new branch, fast-forward, forced, refs/heads prefix; tags, deletions, rejections and up-to-date skipped", () => {
  const out = [
    "To github.com:acme/app.git",
    " * [new branch]      feat -> feat",
    "   1a2b3c4..5d6e7f8  topic -> topic",
    " + 1a2b3c4...5d6e7f8 forced -> forced (forced update)",
    " * [new branch]      HEAD -> refs/heads/other",
    " * [new tag]         v1 -> v1",
    " - [deleted]         gone",
    " ! [rejected]        stale -> stale (non-fast-forward)",
    " ! [remote rejected] hook -> hook (pre-receive hook declined)",
    " = [up to date]      same -> same",
  ].join("\n");
  assert.deepEqual(parsePushOutput(out), ["feat", "topic", "forced", "other"]);
  assert.deepEqual(parsePushOutput("Everything up-to-date"), []);
});

// ------------------------------------------------------------------ PrDots integration

test("a fork setup keys the PR by the answer's URL, never by origin", async () => {
  const h = rig({ branch: "feat" });
  h.state.handle = (c) => (c.op === "pr_status" && c.args.number === undefined ? ran({ number: 5, state: "open", url: url("upstream-org/app", 5) }) : undefined);
  h.d.start();
  await h.fire();
  const batch = h.callsOf("pr_batch")[0];
  assert.deepEqual(batch.args.prs, [{ repo: "upstream-org/app", n: 5 }]);
  assert.deepEqual(h.d.dots(), [{ n: 5, state: "none", label: "upstream-org/app#5" }]);
});

test("number-only registrations are parked until pr_repo answers and keyed by it", async () => {
  const h = rig();
  h.d.onCreated(7);
  assert.equal(h.tracks.length, 0, "parked");
  await flush();
  assert.equal(h.tracks.length, 1);
  assert.equal(h.callsOf("pr_repo").length, 1);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.callsOf("pr_batch")[0].args.prs, [{ repo: "acme/app", n: 7 }]);
  assert.equal(h.callsOf("pr_repo").length, 1, "once per cwd");
});

test("onBash: git push records the branch with cwd, remote, repo and host; -C and cd record the other cwd", async () => {
  const h = rig();
  h.state.repos[path.resolve("/other")] = { host: "git.example.org", repo: "acme/lib" };
  await h.d.onBash("git push -u origin feat", " * [new branch]      feat -> feat", true, "/w");
  await h.d.onBash("git -C /other push up topic", "   1a2b3c4..5d6e7f8  topic -> topic", true, "/w");
  await h.d.onBash("cd sub && git push", " * [new branch]      sub -> sub", true, "/w");
  await h.d.onBash("git stash push", "Saved working directory", true, "/w");
  await h.d.onBash("git push origin gone", " * [new branch]      gone -> gone", false, "/w");
  await flush();
  const p = h.d.pushedBranches().map((x) => ({ name: x.name, cwd: x.cwd, remote: x.remote, repo: x.repo, host: x.host }));
  assert.deepEqual(p, [
    { name: "sub", cwd: path.resolve("/w/sub"), remote: "origin", repo: "acme/app", host: "github.com" },
    { name: "topic", cwd: path.resolve("/other"), remote: "up", repo: "acme/lib", host: "git.example.org" },
    { name: "feat", cwd: "/w", remote: "origin", repo: "acme/app", host: "github.com" },
  ]);
});

test("onBash: a quiet push falls back to the checkout's branch, but not with -C or cd", async () => {
  const h = rig({ quietBranch: "quiet" });
  await h.d.onBash("git push", "", true, "/w");
  await h.d.onBash("git -C /o push", "", true, "/w");
  await h.d.onBash("cd /o && git push", "", true, "/w");
  assert.deepEqual(h.d.pushedBranches().map((x) => x.name), ["quiet"]);
});

test("onBash: the pushed-branch memory holds eight, newest first", async () => {
  const h = rig();
  for (let i = 0; i < 10; i++) await h.d.onBash("git push origin b" + i, ` * [new branch]      b${i} -> b${i}`, true, "/w");
  assert.deepEqual(h.d.pushedBranches().map((x) => x.name), ["b9", "b8", "b7", "b6", "b5", "b4", "b3", "b2"]);
});

test("a dup is traced with dup: true and does not bump recency", async () => {
  const h = rig();
  h.d.trackTool(k(1));
  h.d.trackTool(k(2));
  h.d.trackTool(k(1));
  assert.deepEqual(h.tracks.map((t) => t.dup ?? false), [false, false, true]);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => d.n), [2, 1]);
});

test("pr_untrack ignores the key for automatic paths; pr_track lifts it; trace has no identifying fields", async () => {
  const h = rig();
  h.d.trackTool(k(5));
  h.d.untrack(k(5));
  assert.equal(h.d.track(k(5), "branch").added, false);
  assert.equal(h.d.trackTool(k(5)).added, true);
  for (const t of h.tracks) {
    assert.equal(t.event, "pr_track");
    assert.ok(Object.keys(t).every((x) => ["event", "path", "dup", "skipped", "foreign", "count"].includes(x)));
    assert.doesNotMatch(JSON.stringify(t), /acme|github|feat/);
  }
  assert.ok(h.tracks.some((t) => t.path === "untrack"));
});

test("a pr_batch not-found drops the PR to gone", async () => {
  const h = rig({ branch: "" });
  h.d.onCreated(7, url("acme/app", 7));
  h.state.handle = (c) => (c.op === "pr_batch" ? ran({ prs: [], errors: [{ repo: "acme/app", number: 7, kind: "pr_not_found" }] }) : undefined);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots(), []);
  await h.fire();
  assert.equal(h.callsOf("pr_batch").length, 1, "not asked again");
});

test("hostAllowed: the current host, a remote's host, a tracked PR's host; nothing else", async () => {
  const h = rig({ remotes: ["git.example.org"] });
  assert.equal(await h.d.hostAllowed("GitHub.com", "/w"), true);
  assert.equal(await h.d.hostAllowed("git.example.org", "/w"), true);
  assert.equal(await h.d.hostAllowed("elsewhere.example.net", "/w"), false);
  h.d.onCreated(1, url("acme/x", 1, "elsewhere.example.net"));
  assert.equal(await h.d.hostAllowed("elsewhere.example.net", "/w"), true);
  assert.equal(pre("x").kind, "precondition");
});
