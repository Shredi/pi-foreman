import test from "node:test";
import assert from "node:assert/strict";
import { prCardKey, prTooltip, prCard, PR_LEGEND } from "./model.js";
import { SAMPLE, SAMPLE_MANY } from "./sample.mjs";
import { parseRadarDoc } from "./model.js";

const H = "1".repeat(40);
const base = () => ({
  number: 7, title: "Change", bodyText: "A description that is long enough to count past its first forty characters.", baseRef: "main", mergeable: "MERGEABLE", mergeState: "clean",
  head: H, state: "open", checks: ["ok"], jobs: [{ name: "build", state: "ok" }, { name: "lint", state: "ok" }], waiting: ["scan"], unsettled: false, unreviewed: false,
  review: { state: "ok", head: H },
});

test("prCardKey is equal for an equal copy and changes for every field the card shows", () => {
  const key = prCardKey(base());
  assert.equal(prCardKey(structuredClone(base())), key);
  const changes = {
    number: 8, title: "Other", baseRef: "dev", mergeable: "CONFLICTING", mergeState: "blocked", head: "2".repeat(40), state: "draft", unreviewed: true, unsettled: true,
    bodyText: "x".repeat(70), waiting: ["scan", "license"], review: { state: "unreviewed", head: H }, jobs: [{ name: "build", state: "fail" }, { name: "lint", state: "ok" }],
  };
  for (const [field, value] of Object.entries(changes)) assert.notEqual(prCardKey({ ...base(), [field]: value }), key, `${field} changes the key`);
  assert.notEqual(prCardKey({ ...base(), jobs: [{ name: "build", state: "ok" }, { name: "lint2", state: "ok" }] }), key, "a job name changes it");
  assert.notEqual(prCardKey({ ...base(), bodyText: base().bodyText.slice(0, 60) }), key, "the description length changes it");
  assert.notEqual(prCardKey({ ...base(), review: { state: "ok", head: H, noChecks: true } }), key);
});

test("prCardKey is short: it does not carry the description or the job list in full", () => {
  const long = { ...base(), bodyText: "y".repeat(5000), jobs: Array.from({ length: 200 }, (_, i) => ({ name: `job ${i}`, state: "ok" })) };
  assert.ok(!prCardKey({ ...long, jobs: [] }).includes("y".repeat(41)));
  assert.equal(prCardKey(null), "");
});

test("prTooltip is the state line of prCard for every fixture PR, with the unreviewed words for a flagged one", () => {
  const sampled = [
    ...parseRadarDoc(JSON.stringify(SAMPLE.radar)).openPrs, ...parseRadarDoc(JSON.stringify(SAMPLE_MANY.radar)).openPrs,
    ...PR_LEGEND.map((e) => e.sample), base(), { ...base(), unreviewed: true }, { number: 3, checks: [] }, {},
  ];
  for (const pr of sampled) assert.equal(prTooltip(pr), prCard(pr).state, `#${pr.number}`);
  assert.equal(prTooltip({ ...base(), unreviewed: true }), "#7 · CI passing, not reviewed · unreviewed head".replace("CI passing, not reviewed", prTooltip({ ...base(), unreviewed: true }).split(" · ")[1]));
  assert.ok(prTooltip({ ...base(), unreviewed: true }).endsWith(" · unreviewed head"));
  assert.ok(!prTooltip(base()).includes("unreviewed head"));
});
