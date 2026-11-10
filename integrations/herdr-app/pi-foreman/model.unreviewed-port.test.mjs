import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const live = (waits, host) => ({
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", glyph: "⏳", hcTerminal: "t1", own: cost, tot: cost,
  children: [], waits, repoUrl: `https://${host}/acme/widgets`, repo: "acme/widgets",
  dots: [{ n: 5, state: "ok", label: "#5", src: "pr", url: `https://${host}/acme/widgets/pull/5` }],
});
const wait = (host) => ({ id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [5], unreviewed: [{ n: 5, repo: "acme/widgets", host }] });
const flagged = (prHost, keyHost) => buildTree(parseRadarDoc(JSON.stringify({ v: 1, roots: [live([wait(keyHost)], prHost)], openPrs: [] })).nodes)[0].prs[0].unreviewed === true;

test("a watch key host with a port matches the PR address with the same port", () => {
  assert.equal(flagged("ghe.example.test:8443", "ghe.example.test:8443"), true);
  assert.equal(flagged("GHE.example.test:8443", "ghe.example.test:8443"), true);
});

test("a different port is another host", () => {
  assert.equal(flagged("ghe.example.test:8443", "ghe.example.test:9443"), false);
  assert.equal(flagged("ghe.example.test:8443", "ghe.example.test"), false);
});
