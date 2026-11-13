import test from "node:test";
import assert from "node:assert/strict";
import { prDotState, prCard, prState, prStateText, parseRadarDoc, enrichPrs } from "./model.js";

const feed = (checks, over = {}) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [{ number: 7, repo: "acme/app", title: "t", url: "https://github.com/acme/app/pull/7", checks, ...over }] })).openPrs[0];
const one = [{ n: "ci", state: "ok" }];

test("an unsettled PR with one passed check shows the pending dot, not green", () => {
  const pr = feed(one, { unsettled: true });
  assert.deepEqual(prDotState(pr), { ring: true, fill: "amber", conflict: false });
  assert.equal(prState(pr), "pending");
});

test("an unsettled PR: the card and the state text never say passing", () => {
  const pr = feed(one, { unsettled: true });
  assert.equal(prStateText(pr), "CI running");
  const c = prCard(pr);
  assert.ok(!/pass/i.test(c.state), c.state);
  assert.ok(!/pass/i.test(c.status), c.status);
});

test("an unsettled PR with a failed check shows fail at once", () => {
  const pr = feed([{ n: "ci", state: "ok" }, { n: "lint", state: "fail" }], { unsettled: true });
  assert.equal(prDotState(pr).fill, "red");
  assert.equal(prStateText(pr), "CI failing");
});

test("a PR without the flag behaves as before", () => {
  const pr = feed(one);
  assert.deepEqual(prDotState(pr), { ring: false, fill: "green", conflict: false });
  assert.equal(prStateText(pr), "CI passing");
});

test("enrichPrs carries the flag with the twin's checks", () => {
  const session = { number: 7, repo: "https://github.com/acme/app", checks: ["ok"], jobs: [{ name: "", state: "ok" }], url: "https://github.com/acme/app/pull/7" };
  const [pr] = enrichPrs([session], [feed(one, { unsettled: true })]);
  assert.equal(prDotState(pr).ring, true);
});
