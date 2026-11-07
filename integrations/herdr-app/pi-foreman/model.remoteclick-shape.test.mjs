import test from "node:test";
import assert from "node:assert/strict";
import { remoteClick } from "./model.js";

const node = (over) => ({ key: "k1", name: "fix@m", machine: "m", hcTerminal: "t7", ...over });

test("a valid target still opens", () => {
  assert.deepEqual(remoteClick(node(), []), { kind: "open", target: "m/t7", name: remoteClick(node(), []).name });
});

test("a non-string hcTerminal gives null", () => {
  assert.equal(remoteClick(node({ hcTerminal: 7 }), []), null);
  assert.equal(remoteClick(node({ hcTerminal: ["t7"] }), []), null);
});

test("a flag-like terminal part gives null", () => {
  assert.equal(remoteClick(node({ hcTerminal: "-t7" }), []), null);
  assert.equal(remoteClick(node({ hcTerminal: "m/-t7" }), []), null);
});

test("a target with more than one slash gives null", () => {
  assert.equal(remoteClick(node({ hcTerminal: "m/t7/x" }), []), null);
});

test("a machine of the wrong shape gives null", () => {
  assert.equal(remoteClick(node({ machine: "m/x" }), []), null);
  assert.equal(remoteClick(node({ machine: "m x" }), []), null);
  assert.equal(remoteClick(node({ machine: 5 }), []), null);
});
