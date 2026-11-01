import test from "node:test";
import assert from "node:assert/strict";
import { prCard, enrichPrs, parseRadarDoc } from "./model.js";

const dotPr = (state) => {
  const doc = JSON.stringify({ roots: [{ name: "top", prs: [], dots: [{ n: 57, state, label: "#57", src: "pr" }] }] });
  return parseRadarDoc(doc).nodes[0].prs[0];
};

test("dot-only PR: no invented jobs, a status line and a note", () => {
  for (const [state, status] of [["fail", "checks failed"], ["run", "checks running"], ["ok", "checks passed"]]) {
    const c = prCard(dotPr(state));
    assert.deepEqual(c.groups, [], state);
    assert.equal(c.status, status);
    assert.equal(c.note, "details after the next feed refresh");
    assert.ok(!JSON.stringify(c).includes("job 1"));
  }
});

test("unnamed checks of a feed-shaped PR keep the numbered names, no status line", () => {
  const c = prCard({ number: 7, title: "T", checks: ["ok", "fail"] });
  assert.deepEqual(c.groups.map((g) => g.names), [["job 2"], ["job 1"]]);
  assert.equal(c.status, "");
  assert.equal(c.note, "");
});

test("excerpt from a body starting with a heading, plain or raw Markdown", () => {
  const body = "Permissions are now rules first, then the mode";
  assert.equal(prCard({ number: 1, bodyText: `Summary\n\n${body}` }).excerpt, `Summary ${body}`);
  assert.equal(prCard({ number: 1, bodyText: `## Summary\n\n${body}` }).excerpt, `Summary ${body}`);
});

test("feed checks with n or name show by name in the failed group", () => {
  for (const key of ["n", "name"]) {
    const feed = [{ repo: "a/b", number: 57, title: "T", url: "https://github.com/a/b/pull/57", checks: [{ [key]: "bench-smoke", state: "fail" }] }];
    const feedPrs = parseRadarDoc(JSON.stringify({ roots: [], openPrs: feed })).openPrs;
    const c = prCard(enrichPrs([dotPr("fail")], feedPrs)[0]);
    assert.equal(c.groups[0].key, "failed");
    assert.deepEqual(c.groups[0].names, ["bench-smoke"]);
    assert.equal(c.status, "");
  }
});
