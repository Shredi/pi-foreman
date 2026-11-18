import test from "node:test";
import assert from "node:assert/strict";
import { mergeFeeds } from "./model.js";

const pr = (over = {}) => ({ number: 5, repo: "o/r", url: "", title: "", checks: [], jobs: [], state: "open", ...over });
const URL_A = "https://a.example.test/o/r/pull/5";
const URL_B = "https://b.example.test/o/r/pull/5";
const job = (name, state = "ok") => ({ name, state });

test("two machine feeds with the same PRs give one entry each, in first-seen order", () => {
  const a = [pr({ number: 5, url: URL_A }), pr({ number: 6, url: "https://a.example.test/o/r/pull/6" })];
  const b = [pr({ number: 6, url: "https://a.example.test/o/r/pull/6" }), pr({ number: 7, url: "https://a.example.test/o/r/pull/7" }), pr({ number: 5, url: URL_A })];
  assert.deepEqual(mergeFeeds([a, b]).map((p) => p.number), [5, 6, 7]);
});

test("the first entry wins; the later copy fills the plain gaps one by one", () => {
  const first = pr({ url: URL_A, title: "First", bodyText: "" });
  const later = pr({ url: URL_A, title: "Later", bodyText: "Body", branch: "fix", baseRef: "main", mergeable: "ok", head: "abc", mergeState: "clean", headRepo: "o/r" });
  const [m] = mergeFeeds([[first], [later]]);
  assert.equal(m.title, "First");
  assert.equal(m.bodyText, "Body");
  assert.equal(m.branch, "fix");
  assert.equal(m.baseRef, "main");
  assert.equal(m.mergeable, "ok");
  assert.equal(m.head, "abc");
  assert.equal(m.mergeState, "clean");
  assert.equal(m.headRepo, "o/r");
});

test("the check block comes as one: from the first entry with jobs, never mixed", () => {
  const settled = pr({ url: URL_A, checks: [{ n: "x", state: "ok" }], jobs: [] });
  const withJobs = pr({ url: URL_A, checks: [{ n: "ci", state: "run" }], jobs: [job("ci", "run")], unsettled: true });
  const [m] = mergeFeeds([[settled], [withJobs]]);
  assert.deepEqual(m.jobs, withJobs.jobs);
  assert.deepEqual(m.checks, withJobs.checks);
  assert.equal(m.unsettled, true);

  const first = pr({ url: URL_A, checks: [{ n: "ci", state: "ok" }], jobs: [job("ci")] });
  const unsettledLater = pr({ url: URL_A, checks: [{ n: "ci", state: "run" }], jobs: [job("other", "run")], unsettled: true });
  const [k] = mergeFeeds([[first], [unsettledLater]]);
  assert.deepEqual(k.jobs, first.jobs);
  assert.deepEqual(k.checks, first.checks);
  assert.equal("unsettled" in k, false);
});

test("hiddenRepo is true when either entry has it", () => {
  assert.equal(mergeFeeds([[pr({ url: URL_A })], [pr({ url: URL_A, hiddenRepo: true })]])[0].hiddenRepo, true);
  assert.equal(mergeFeeds([[pr({ url: URL_A, hiddenRepo: true })], [pr({ url: URL_A })]])[0].hiddenRepo, true);
});

test("the host is read from repo when it is an https URL and the entry has no URL", () => {
  const a = pr({ repo: "https://a.example.test/o/r" });
  const b = pr({ repo: "https://b.example.test/o/r" });
  assert.equal(mergeFeeds([[a], [b]]).length, 2);
  assert.equal(mergeFeeds([[a], [pr({ repo: "https://a.example.test/o/r" })]]).length, 1);
});

test("same repository and number on two different hosts are two entries; an unknown host on one side merges", () => {
  assert.equal(mergeFeeds([[pr({ url: URL_A })], [pr({ url: URL_B })]]).length, 2);
  assert.equal(mergeFeeds([[pr({ url: URL_A })], [pr({ url: "" })]]).length, 1);
  assert.equal(mergeFeeds([[pr({ url: "" })], [pr({ url: URL_B })]]).length, 1);
});

test("three copies (host unknown, A, B) give two entries in every order; the unknown copy joins the first known-host entry", () => {
  const U = pr({ url: "", title: "U" });
  const A = pr({ url: URL_A, title: "A" });
  const B = pr({ url: URL_B, title: "B" });
  const orders = [[U, A, B], [U, B, A], [A, U, B], [A, B, U], [B, U, A], [B, A, U]];
  for (const order of orders) {
    const out = mergeFeeds(order.map((p) => [p]));
    assert.equal(out.length, 2, order.map((p) => p.title).join(","));
    assert.deepEqual(out.map((p) => p.url.split("/")[2]).sort(), ["a.example.test", "b.example.test"]);
  }
  const firstKnown = mergeFeeds([[B], [U], [A]]);
  assert.equal(firstKnown[0].url, URL_B);
  assert.equal(firstKnown[1].url, URL_A);
});

test("repository or URL spelled in another case is one entry", () => {
  assert.equal(mergeFeeds([[pr({ repo: "o/r" })], [pr({ repo: "O/R" })]]).length, 1);
  assert.equal(mergeFeeds([[pr({ url: URL_A })], [pr({ url: URL_A.toUpperCase().replace("HTTPS", "https") })]]).length, 1);
  assert.equal(mergeFeeds([[pr({ repo: "", url: URL_A })], [pr({ repo: "", url: "https://a.example.test/O/R/pull/5" })]]).length, 1);
});

test("entries without repository and URL are kept as they are", () => {
  const a = pr({ repo: "", url: "" });
  const b = pr({ repo: "", url: "" });
  const out = mergeFeeds([[a], [b]]);
  assert.equal(out.length, 2);
  assert.equal(out[0], a);
  assert.equal(out[1], b);
});

test("non-array feeds are ignored", () => {
  const a = pr({ url: URL_A });
  const out = mergeFeeds([null, undefined, "x", { length: 1 }, [a]]);
  assert.equal(out.length, 1);
  assert.deepEqual(mergeFeeds(null), []);
});

test("untouched entries keep their object identity; a merged one is a new object", () => {
  const a = pr({ number: 5, url: URL_A });
  const other = pr({ number: 9, url: "https://a.example.test/o/r/pull/9" });
  const dup = pr({ number: 5, url: URL_A, title: "T" });
  const out = mergeFeeds([[a, other], [dup]]);
  assert.equal(out[1], other);
  assert.notEqual(out[0], a);
  assert.equal(a.title, "");
  assert.equal(out[0].title, "T");
});
