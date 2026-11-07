import test from "node:test";
import assert from "node:assert/strict";
import { remoteClick, attachNests } from "./model.js";

// A node shaped as scripts/foreman_radar.py emits a remote registry session: the terminal is `<machine>/<t>`.
const radarNode = { key: "fm-fix-the-bug-1a2b3c4", name: "fix@m1", machine: "m1", hcTerminal: "m1/t7", state: "working", children: [] };
const attach = (address, target) => ({ address, state: "live", argv: ["sh", "-c", `hc attach ${target}`] });

test("a radar-shaped remote node is clicked and nested through its address", () => {
  assert.deepEqual(remoteClick(radarNode, [attach("t2", "m1/t7")]), { kind: "focus", address: "t2" });
  assert.equal(remoteClick(radarNode, []).target, "m1/t7");
  const nests = attachNests([{ address: "t2" }], [attach("t2", "m1/t7")], new Set([radarNode.hcTerminal]));
  assert.deepEqual([...nests], ["t2"]);
});

test("a terminal known as an attach only through `hc get` is focused, not duplicated", () => {
  const all = [{ address: "t4", state: "live" }];
  assert.deepEqual(remoteClick(radarNode, all, (a) => (a === "t4" ? "m1/t7" : "")), { kind: "focus", address: "t4" });
  assert.equal(remoteClick(radarNode, all).kind, "open");
});
