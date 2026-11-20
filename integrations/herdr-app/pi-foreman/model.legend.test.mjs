import test from "node:test";
import assert from "node:assert/strict";
import { PR_LEGEND, prStateText, prDotState, prTones } from "./model.js";

const theme = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${k}` : undefined) });
const CONFLICT = "pr-conflict"; // names the mark beside the dot, not a dot state: prStateText does not say it
const dotted = PR_LEGEND.filter((e) => e.key !== CONFLICT);

test("every legend entry but the conflict one is worded as prStateText words its sample", () => {
  assert.ok(dotted.length >= 15);
  for (const e of dotted) assert.equal(prStateText(e.sample), e.words, e.key);
  assert.equal(new Set(PR_LEGEND.map((e) => e.key)).size, PR_LEGEND.length, "no key twice");
  assert.equal(PR_LEGEND.find((e) => e.key === CONFLICT).sample.mergeable, "CONFLICTING");
});

test("the dot of every legend entry has a colour in prTones", () => {
  const tones = prTones(theme);
  for (const e of PR_LEGEND) {
    const { fill } = prDotState(e.sample);
    assert.ok(Object.hasOwn(tones, fill), `${e.key}: fill ${fill} is a tone`);
    assert.equal(typeof tones[fill], "string", `${e.key}: the tone has a colour`);
  }
});

// Every combination of the inputs the dot and its words read.
function* grid() {
  const head = "1".repeat(40);
  const checkSets = [[], ["ok"], ["run"], ["fail"], ["fail", "run"], ["ok", "run"]];
  const reviews = [undefined, { state: "ok", head }, { state: "ok", head, noChecks: true }, { state: "unreviewed", head }];
  for (const checks of checkSets) for (const state of [undefined, "draft"]) for (const mergeState of [undefined, "clean", "blocked", "behind", "dirty"])
    for (const mergeable of ["UNKNOWN", "MERGEABLE", "CONFLICTING"]) for (const unreviewed of [false, true]) for (const waiting of [undefined, ["required-check"]])
      for (const review of reviews) yield { number: 1, head, checks, state, mergeState, mergeable, unreviewed, waiting, review };
}

test("the legend words are exactly what prStateText can say, so a new state without a row fails", () => {
  const said = new Set();
  for (const pr of grid()) said.add(prStateText(pr));
  assert.ok(said.size > 10, `${said.size} distinct wordings`);
  assert.deepEqual([...said].sort(), dotted.map((e) => e.words).sort());
});
