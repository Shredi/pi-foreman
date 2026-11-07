import test from "node:test";
import assert from "node:assert/strict";
import { remoteClick, attachName, attachNests } from "./model.js";

const node = { key: "fm-fix-the-bug-1a2b3c4", name: "fix@m1", machine: "m1", hcTerminal: "t7" };
const attach = (address, target, extra = {}) => ({ address, state: "live", argv: ["sh", "-c", `hc attach ${target}`], ...extra });

test("a click focuses the local terminal that already follows the target", () => {
  const all = [{ address: "t1", state: "live" }, attach("t2", "m1/t7")];
  assert.deepEqual(remoteClick(node, all), { kind: "focus", address: "t2" });
});

test("a click opens an attach terminal when none follows the target", () => {
  const all = [attach("t2", "m1/t9"), attach("t3", "m1/t7", { state: "gone" })];
  const plan = remoteClick(node, all);
  assert.equal(plan.kind, "open");
  assert.equal(plan.target, "m1/t7");
  assert.equal(plan.name, attachName("m1", node.key));
  assert.equal(plan.name, "fm-m1-fix-the-bug-b3c4");
  assert.ok(plan.name.length <= 32);
});

test("a local or terminal-less node has no click", () => {
  assert.equal(remoteClick({ ...node, machine: null }, []), null);
  assert.equal(remoteClick({ ...node, hcTerminal: null }, []), null);
});

test("a hand-made attach of a drawn remote session is nested, another is not", () => {
  const list = [{ address: "t2" }, { address: "t3" }, { address: "t4" }];
  const all = [attach("t2", "m1/t7"), attach("t3", "m1/t8"), { address: "t4", state: "live" }];
  const nests = attachNests(list, all, new Set(["m1/t7"]), (a) => (a === "t4" ? "m1/t7" : ""));
  assert.deepEqual([...nests].sort(), ["t2", "t4"]);
});
