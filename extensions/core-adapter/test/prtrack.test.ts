import { test } from "node:test";
import assert from "node:assert/strict";
import { PrRegistry, chainSegments, compilePatterns, detectInteraction, keyString, matchPatterns, parsePrUrl, parsePush, parsePushOutput, registerTouched, scanUrls } from "../prtrack.ts";
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

test("scanUrls: distinct identities, at most two", () => {
  const text = "see https://github.com/acme/app/pull/1 and https://github.com/acme/app/pull/1/files, https://github.com/acme/app/pull/2 and https://github.com/acme/app/pull/3";
  assert.deepEqual(scanUrls(text).map((x) => x.n), [1, 2]);
  assert.deepEqual(scanUrls("nothing here"), []);
});

test("registry: identity is host, repo and number; the same number in two repos is two PRs", () => {
  const r = new PrRegistry();
  assert.equal(r.register(k(5), "url").added, true);
  assert.equal(r.register(k(5, "acme/other"), "url").added, true);
  assert.equal(r.register(k(5, "ACME/App", "GitHub.com"), "url").added, false, "case-insensitive");
  assert.equal(r.size, 2);
  assert.equal(keyString(k(5, "ACME/App", "GitHub.com")), keyString(k(5)));
});

test("registry: newest first, cap six, the oldest weak entry evicted; first source kept and dup does not move", () => {
  const r = new PrRegistry();
  for (let n = 1; n <= 6; n++) r.register(k(n), "url");
  assert.deepEqual(r.register(k(7), "url"), { added: true, evicted: k(1) });
  assert.deepEqual(r.list().map((e) => e.key.n), [7, 6, 5, 4, 3, 2]);
  assert.deepEqual(r.register(k(4), "interact"), { added: false, dup: true });
  assert.equal(r.get(k(4))?.source, "url", "first source kept");
  assert.deepEqual(r.list().map((e) => e.key.n), [7, 6, 5, 4, 3, 2], "a dup does not move");
});

test("registry: a flood of weak registrations never evicts push, create, interact, tool or watch entries", () => {
  const r = new PrRegistry();
  r.register(k(1), "push");
  r.register(k(2), "create");
  r.register(k(3), "interact");
  r.register(k(4), "tool");
  r.register(k(5), "watch");
  r.register(k(6), "url");
  for (let n = 100; n < 120; n++) {
    for (const s of ["url", "events", "search", "branch"] as const) r.register(k(n), s);
  }
  assert.deepEqual(new Set(r.list().map((e) => e.key.n)), new Set([1, 2, 3, 4, 5, 119]));
  const full = new PrRegistry(2);
  full.register(k(1), "push");
  full.register(k(2), "create");
  assert.deepEqual(full.register(k(3), "url"), { added: false, skipped: true, reason: "full" });
  assert.deepEqual(full.register(k(4), "interact"), { added: true, evicted: k(1) }, "a protected entry evicts the oldest");
});

test("registry: a repeated create moves to the front; ignored blocks automatic paths and pr_track lifts it; gone keeps the head", () => {
  const r = new PrRegistry();
  r.register(k(1), "create");
  r.register(k(2), "create");
  r.register(k(1), "create");
  assert.deepEqual(r.list().map((e) => e.key.n), [1, 2]);
  r.untrack(k(2));
  assert.equal(r.has(k(2)), false);
  assert.deepEqual(r.register(k(2), "url"), { added: false, skipped: true, reason: "ignored" });
  assert.equal(r.register(k(2), "tool").added, true);
  assert.equal(r.isIgnored(k(2)), false);
  r.register(k(3), "push", "topic");
  r.markGone(k(3));
  assert.equal(r.knownHead("github.com", "acme/app", "topic"), true);
  assert.equal(r.knownHead("github.com", "acme/other", "topic"), false);
  assert.deepEqual(r.register(k(3), "url"), { added: false, skipped: true, reason: "gone" });
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

test("detectInteraction: gh pr verbs, -R, URLs, non-verbs", () => {
  const d = (cmd: string) => detectInteraction(seg(cmd)[0]);
  for (const v of ["comment", "review", "checkout", "merge", "ready", "edit", "close", "reopen"]) assert.deepEqual(d(`gh pr ${v} 5`), { n: 5 }, v);
  assert.equal(d("gh pr view 5"), null);
  assert.equal(d("gh pr list"), null);
  assert.deepEqual(d("gh pr comment 5 -R acme/other -b hi"), { n: 5, repo: "acme/other" });
  assert.deepEqual(d("gh pr merge --repo git.example.org/acme/other 6"), { n: 6, repo: "acme/other", host: "git.example.org" });
  assert.deepEqual(d("gh pr comment -b 7 https://github.com/acme/web/pull/9"), { n: 9, repo: "acme/web", host: "github.com" });
  assert.deepEqual(d("GH_REPO=acme/env gh pr close 8"), { n: 8, repo: "acme/env" });
  assert.equal(d("gh pr comment feat"), null, "a branch name does not identify a PR");
  assert.equal(d("git commit -m 'gh pr comment 5'"), null);
});

test("detectInteraction: gh api write methods and paths, placeholders map to the current repo", () => {
  const d = (cmd: string) => detectInteraction(seg(cmd)[0]);
  assert.deepEqual(d("gh api -X POST repos/acme/app/issues/4/comments -f body=hi"), { n: 4, repo: "acme/app" });
  assert.deepEqual(d("gh api repos/acme/app/pulls/4/reviews -f event=COMMENT"), { n: 4, repo: "acme/app" }, "-f implies POST");
  assert.deepEqual(d("gh api --method PATCH repos/acme/app/pulls/4"), { n: 4, repo: "acme/app" });
  assert.deepEqual(d("gh api -X PUT repos/acme/app/pulls/4/requested_reviewers --input x.json"), { n: 4, repo: "acme/app" });
  assert.deepEqual(d("gh api -X POST 'repos/{owner}/{repo}/issues/4/comments' -f body=x"), { n: 4 });
  assert.deepEqual(d("gh api -X POST repos/:owner/:repo/pulls/4/reviews"), { n: 4 });
  assert.deepEqual(d("gh api -X POST repos/acme/app/issues/4/comments --hostname git.example.org -f body=x"), { n: 4, repo: "acme/app", host: "git.example.org" });
  assert.equal(d("gh api repos/acme/app/pulls/4"), null, "a read");
  assert.equal(d("gh api -X GET repos/acme/app/pulls/4/comments -f per_page=1"), null);
  assert.equal(d("gh api -X DELETE repos/acme/app/issues/4"), null);
  assert.equal(d("gh api -X POST repos/acme/app/git/refs -f ref=x"), null);
});

test("detectInteraction: glab mr verbs", () => {
  const d = (cmd: string) => detectInteraction(seg(cmd)[0]);
  for (const v of ["note", "approve", "checkout", "merge", "update", "close", "reopen"]) assert.deepEqual(d(`glab mr ${v} 3`), { n: 3 }, v);
  assert.equal(d("glab mr view 3"), null);
  assert.deepEqual(d("glab mr note 3 -R acme/app -m hi"), { n: 3, repo: "acme/app" });
  assert.deepEqual(d("glab mr merge https://git.example.org/acme/app/-/merge_requests/3"), { n: 3, repo: "acme/app", host: "git.example.org" });
});

test("tools.prInteractions: groups n, repo, host; caps; invalid patterns skipped", () => {
  const list = [{ pattern: "^ci-cli ack (?<n>\\d+)$" }, { pattern: "^ci-cli ack-in (?<repo>[\\w./-]+)#(?<n>\\d+)$" }, { pattern: "(" }, { pattern: "x".repeat(201) }, { nope: 1 }, "bad"];
  const re = compilePatterns(list);
  assert.equal(re.length, 2);
  assert.deepEqual(matchPatterns(re, "ci-cli ack 12"), { n: 12 });
  assert.deepEqual(matchPatterns(re, "ci-cli ack-in acme/web#13"), { n: 13, repo: "acme/web" });
  assert.equal(matchPatterns(re, "other"), null);
  assert.equal(matchPatterns(compilePatterns([{ pattern: "(?<n>\\d+)" }]), "99999999999"), null, "number out of range");
  assert.equal(compilePatterns(Array.from({ length: 30 }, () => ({ pattern: "(?<n>1)" }))).length, 16);
  assert.deepEqual(compilePatterns("nope"), []);
});

test("registerTouched: current or a pushed branch's repo only, younger than 24 h, dup", () => {
  const r = new PrRegistry();
  const now = 10 * 24 * 3600 * 1000;
  const item = (n: number, repo: string, ageH: number) => ({ host: "github.com", repo, n, at: now - ageH * 3600 * 1000 });
  const scope = { current: { host: "github.com", repo: "acme/app" }, pushed: [{ host: "github.com", repo: "acme/lib" }], now };
  const out = registerTouched(r, [item(1, "acme/app", 1), item(2, "acme/lib", 2), item(3, "acme/web", 1), item(4, "acme/app", 25), item(1, "acme/app", 1), { bad: true }], scope);
  assert.deepEqual(out.map((x) => ("added" in x && x.added) || ("dup" in x && "dup")), [true, true, "dup"]);
  assert.deepEqual(r.list().map((e) => [e.key.n, e.source]).sort(), [[1, "events"], [2, "events"]]);
  assert.deepEqual(registerTouched(r, "nope", scope), []);
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
  h.state.repos["/other"] = { host: "git.example.org", repo: "acme/lib" };
  await h.d.onBash("git push -u origin feat", " * [new branch]      feat -> feat", true, "/w");
  await h.d.onBash("git -C /other push up topic", "   1a2b3c4..5d6e7f8  topic -> topic", true, "/w");
  await h.d.onBash("cd sub && git push", " * [new branch]      sub -> sub", true, "/w");
  await h.d.onBash("git stash push", "Saved working directory", true, "/w");
  await h.d.onBash("git push origin gone", " * [new branch]      gone -> gone", false, "/w");
  await flush();
  const p = h.d.pushedBranches().map((x) => ({ name: x.name, cwd: x.cwd, remote: x.remote, repo: x.repo, host: x.host }));
  assert.deepEqual(p, [
    { name: "sub", cwd: "/w/sub", remote: "origin", repo: "acme/app", host: "github.com" },
    { name: "topic", cwd: "/other", remote: "up", repo: "acme/lib", host: "git.example.org" },
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

test("onBash: interactions register under the current repo; a non-zero exit and gh pr view do not", async () => {
  const h = rig();
  await h.d.onBash("gh pr comment 5 -b hi", "", true, "/w");
  await h.d.onBash("gh pr comment 6 -b hi", "", false, "/w");
  await h.d.onBash("gh pr view 7", "", true, "/w");
  await h.d.onBash("gh pr comment 8 -R acme/web", "", true, "/w");
  assert.deepEqual(h.tracks.map((t) => [t.path, t.foreign ?? false]), [["interact", false], ["interact", true]]);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.callsOf("pr_batch")[0].args.prs, [{ repo: "acme/web", n: 8 }, { repo: "acme/app", n: 5 }]);
});

test("onBash: after cd the number is resolved through pr_repo in that directory; GH_REPO is honoured; unresolved is skipped", async () => {
  const h = rig();
  h.state.repos["/w/other"] = { host: "github.com", repo: "acme/other" };
  h.state.repos["/w/none"] = null;
  await h.d.onBash("cd other && gh pr comment 5 -b hi", "", true, "/w");
  await h.d.onBash("GH_REPO=acme/env gh pr comment 6 -b hi", "", true, "/w");
  await h.d.onBash("cd none && gh pr comment 7 -b hi", "", true, "/w");
  await h.d.onBash("cd $X && gh pr comment 9 -b hi", "", true, "/w");
  assert.deepEqual(h.tracks.map((t) => [t.path, t.skipped ?? false]), [["interact", false], ["interact", false], ["interact", true], ["interact", true]]);
  assert.equal(h.callsOf("pr_repo").filter((c) => c.cwd === "/w/other").length, 1);
  h.d.start();
  await h.fire();
  const prs = h.callsOf("pr_batch")[0].args.prs as { repo: string; n: number }[];
  assert.deepEqual(prs.map((p) => `${p.repo}#${p.n}`).sort(), ["acme/env#6", "acme/other#5"]);
});

test("onBash: gh api placeholders map to the current repo and tools.prInteractions patterns register", async () => {
  const h = rig({ interactions: [{ pattern: "^ci-cli ack (?<n>\\d+)$" }] });
  await h.d.onBash("gh api -X POST 'repos/{owner}/{repo}/issues/4/comments' -f body=x", "", true, "/w");
  await h.d.onBash("ci-cli ack 12", "", true, "/w");
  h.d.start();
  await h.fire();
  const prs = h.callsOf("pr_batch")[0].args.prs as { repo: string; n: number }[];
  assert.deepEqual(prs.map((p) => p.n).sort(), [12, 4]);
  assert.ok(prs.every((p) => p.repo === "acme/app"));
});

test("URL scan: output URLs register under their own identity; at most two; the host rule", async () => {
  const h = rig({ remotes: ["github.com"] });
  const text = `${url("acme/a", 1)} ${url("acme/b", 2)} ${url("acme/c", 3)} ${url("acme/d", 4, "evil.example.net")}`;
  await h.d.onResult(text, "/w");
  assert.deepEqual(h.tracks.map((t) => t.path), ["url", "url"]);
  await h.d.onResult(url("acme/d", 4, "evil.example.net"), "/w");
  assert.deepEqual(h.tracks.at(-1), { event: "pr_track", path: "url", count: 2, skipped: true });
  h.d.onCreated(9, url("acme/e", 9, "other.example.org"));
  await h.d.onResult(url("acme/f", 10, "other.example.org"), "/w");
  assert.equal(h.tracks.at(-1)?.skipped, undefined, "the host of a tracked PR is accepted");
});

test("URL scan: a flood never evicts a push, create, interact, tool or watch entry; skipped is traced", async () => {
  const h = rig();
  for (let n = 1; n <= 6; n++) h.d.onCreated(n, url("acme/app", n));
  for (let n = 100; n < 110; n++) await h.d.onResult(url("acme/app", n), "/w");
  const urls = h.tracks.filter((t) => t.path === "url");
  assert.equal(urls.length, 10);
  assert.ok(urls.every((t) => t.skipped === true));
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => d.n).sort(), [1, 2, 3, 4, 5, 6]);
});

test("a dup is traced with dup: true and does not bump recency", async () => {
  const h = rig();
  await h.d.onResult(url("acme/app", 1) + " " + url("acme/app", 2), "/w");
  await h.d.onResult(url("acme/app", 1), "/w");
  assert.deepEqual(h.tracks.map((t) => t.dup ?? false), [false, false, true]);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((d) => d.n), [2, 1]);
});

test("pr_untrack ignores the key for automatic paths; pr_track lifts it; trace has no identifying fields", async () => {
  const h = rig();
  h.d.trackTool(k(5));
  h.d.untrack(k(5));
  await h.d.onResult(url("acme/app", 5), "/w");
  assert.equal(h.d.trackTool(k(5)).added, true);
  for (const t of h.tracks) {
    assert.equal(t.event, "pr_track");
    assert.ok(Object.keys(t).every((x) => ["event", "path", "dup", "skipped", "foreign", "count"].includes(x)));
    assert.doesNotMatch(JSON.stringify(t), /acme|github|feat/);
  }
  assert.ok(h.tracks.some((t) => t.path === "untrack"));
});

test("events: onTouched registers the current repo's items and traces path events", async () => {
  const h = rig();
  await flush();
  h.d.onCreated(1);
  await flush();
  h.d.onTouched([{ host: "github.com", repo: "acme/app", n: 30, at: 1_000_000 - 1000 }, { host: "github.com", repo: "acme/web", n: 31, at: 1_000_000 }]);
  assert.deepEqual(h.tracks.map((t) => t.path), ["create", "events"]);
});

test("events: the same snapshot on two ticks writes one trace record", async () => {
  const h = rig();
  await flush();
  h.d.onCreated(1);
  await flush();
  const items = [{ host: "github.com", repo: "acme/app", n: 30, at: 1_000_000 - 1000 }];
  h.tracks.length = 0;
  h.d.onTouched(items);
  h.d.onTouched(items);
  assert.deepEqual(h.tracks.map((t) => t.path), ["events"]);
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
