import test from "node:test";
import assert from "node:assert/strict";
import { prCardKey } from "./model.js";

const base = () => ({
  number: 7, title: "Change", bodyText: "text", baseRef: "main", mergeable: "MERGEABLE", mergeState: "clean", head: "1".repeat(40), state: "open",
  jobs: [{ name: "build", state: "ok" }, { name: "deploy", state: "pending" }], gated: true, gate: { state: "waiting", waiting: ["deploy"] },
});

test("prCardKey is equal for identical input", () => {
  assert.equal(prCardKey(base()), prCardKey(structuredClone(base())));
});

test("prCardKey changes with gate state, gate waiting and the gated flag", () => {
  const key = prCardKey(base());
  assert.notEqual(prCardKey({ ...base(), gate: { state: "passed", waiting: ["deploy"] } }), key, "gate.state");
  assert.notEqual(prCardKey({ ...base(), gate: { state: "waiting", waiting: ["deploy", "scan"] } }), key, "gate.waiting");
  assert.notEqual(prCardKey({ ...base(), gated: false }), key, "gated");
});

test("prCardKey changes with a check's phase while name and state stay", () => {
  const withPhase = (phase) => ({ ...base(), jobs: [{ name: "build", state: "ok", ...(phase === undefined ? {} : { phase }) }] });
  const none = prCardKey(withPhase(undefined));
  const two = prCardKey(withPhase(2));
  assert.notEqual(none, two);
  assert.notEqual(two, prCardKey(withPhase("ignore")));
});
