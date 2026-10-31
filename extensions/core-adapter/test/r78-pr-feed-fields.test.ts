import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BODY, MAX_CHECKS, openPrsConfig, parseSearch } from "../openprs.ts";
import { redactCommand } from "../trace.ts";
import { Where, repoOfRemote } from "../where.ts";

const node = (over: Record<string, unknown> = {}, checks = 1) => ({
  number: 1, title: "t", url: "https://example.test/acme/widgets/pull/1", isDraft: false,
  repository: { nameWithOwner: "acme/widgets" }, author: { login: "octo" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: Array.from({ length: checks }, (_, i) => ({ __typename: "CheckRun", name: `c${i}`, status: "COMPLETED", conclusion: "SUCCESS" })) } } } }] },
  ...over,
});
const parse = (n: unknown) => parseSearch(JSON.stringify({ data: { search: { nodes: [n] } } }))[0];

test("headRefName, bodyText and mergeable are carried; an absent or invalid value leaves the key out", () => {
  const p = parse(node({ headRefName: "feat/x", bodyText: "Fixes\n\nthe  flaky wait.", mergeable: "CONFLICTING" }));
  assert.equal(p.headRefName, "feat/x");
  assert.equal(p.bodyText, "Fixes the flaky wait.");
  assert.equal(p.mergeable, "CONFLICTING");
  assert.equal(parse(node({ mergeable: "MERGEABLE" })).mergeable, "MERGEABLE");
  assert.equal(parse(node({ mergeable: "UNKNOWN" })).mergeable, "UNKNOWN");
  const bare = parse(node({ headRefName: "", bodyText: "  \n ", mergeable: "MAYBE" }));
  for (const k of ["headRefName", "bodyText", "mergeable"]) assert.equal(k in bare, false, k);
  assert.equal("headRefName" in parse(node({ headRefName: 5, bodyText: 7 })), false);
});

test("bodyText is redacted before the cut and cut to 500 characters", () => {
  const p = parse(node({ bodyText: `token=abc123456789 ghp_abcdef123456 npm_abcdef123456 ${"y".repeat(900)}` }));
  assert.equal(MAX_BODY, 500);
  assert.equal(p.bodyText!.length, 500);
  assert.match(p.bodyText!, /^token=\[redacted\] \[redacted\] \[redacted\] y+$/);
  assert.equal(parse(node({ bodyText: "x".repeat(499) })).bodyText!.length, 499);
});

test("up to 20 checks are kept per PR", () => {
  assert.equal(MAX_CHECKS, 20);
  assert.equal(parse(node({}, 30)).checks.length, 20);
  assert.equal(parse(node({}, 20)).checks.length, 20);
});

test("the open-PRs source is on unless radar.openPrs.enabled is false; the default refresh is 120 s", () => {
  assert.equal(openPrsConfig(undefined).enabled, true);
  assert.equal(openPrsConfig({}).enabled, true);
  assert.equal(openPrsConfig({ enabled: false }).enabled, false);
  assert.equal(openPrsConfig({}).refreshSeconds, 120);
});

test("redactCommand masks npm_, glpat- and AIza tokens", () => {
  for (const t of ["npm_AbCdEf123456", "glpat-AbCdEf123456-x", "AIzaSyA-bcdef123456"]) {
    assert.equal(redactCommand(`curl -u x ${t} end`), "curl -u x [redacted] end", t);
  }
  assert.equal(redactCommand("npm install left-pad"), "npm install left-pad");
});

test("repoOfRemote reads https, ssh and scp origin URLs", () => {
  assert.equal(repoOfRemote("https://github.com/acme/widgets.git\n"), "acme/widgets");
  assert.equal(repoOfRemote("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(repoOfRemote("ssh://git@host.example/acme/widgets"), "acme/widgets");
  assert.equal(repoOfRemote("not a url"), null);
});

test("Where reads repo and branch once per refresh, reports a change and never throws", async () => {
  let repoCalls = 0;
  let branch = "main";
  let changes = 0;
  const w = new Where({
    cwd: () => "/x", repo: async () => (repoCalls++, "acme/widgets"), branch: async () => branch, changed: () => { changes++; },
  });
  assert.deepEqual(w.read(), { repo: null, branch: null });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.read(), { repo: "acme/widgets", branch: "main" });
  assert.equal(changes, 1);
  await new Promise((r) => setImmediate(r));
  branch = "feat/y";
  assert.equal(w.read().branch, "main");
  await new Promise((r) => setImmediate(r));
  assert.equal(w.read().branch, "feat/y");
  assert.equal(changes, 2);
  assert.equal(repoCalls, 1);
  const bad = new Where({ cwd: () => "/x", repo: async () => { throw new Error("boom"); }, branch: async () => "b", changed: () => undefined });
  bad.read();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bad.read(), { repo: null, branch: null });
});
