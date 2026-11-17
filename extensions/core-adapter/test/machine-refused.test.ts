// pi-subagents 0.89 adds `machine: "local"` (a pane child). The harness adds no gate for it: pi-subagents itself refuses every `machine`
// value while a required child extension is registered with `requireForAllRunners: true`, the way the adapter registers itself (index.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegister } from "../childext.ts";
import { assertRequiredChildExtensionsAdmitted, resolveRequiredChildExtensions } from "../../../node_modules/pi-subagents/src/shared/required-child-extensions.js";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

test("a launch with machine local or remote is refused while the harness's child extension is registered for all runners", async () => {
  const sessionId = `machine-refused-${process.pid}`;
  const { fn } = await loadRegister();
  const registration = fn({ sessionId, extensions: [{ id: "pi-foreman", path: ENTRY }], requireForAllRunners: true });
  try {
    const snapshot = resolveRequiredChildExtensions(sessionId);
    assert.equal(snapshot.some((e: { requireForAllRunners?: boolean }) => e.requireForAllRunners === true), true);
    assert.doesNotThrow(() => assertRequiredChildExtensionsAdmitted([snapshot], { agent: "builder" }));
    for (const machine of ["local", "remote-box"]) {
      assert.throws(() => assertRequiredChildExtensionsAdmitted([snapshot], { agent: "builder", machine }), new RegExp(`cannot run on machine '${machine}'.*pi-foreman`));
    }
  } finally {
    registration.dispose();
  }
});
