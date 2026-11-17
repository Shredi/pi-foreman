// R46 item 8: a builder launch carries `install: true` in the binding and the child reads it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindLaunch, readBinding, recordUsageLaunch, BINDINGS_ENV } from "../usage.ts";

// builder launches carry install in the binding; the child reads it back
for (const role of ["builder"]) {
  test(`${role} launch binding carries install and the child reads it`, () => {
    const reg = new Map();
    const b = recordUsageLaunch(reg, { foremanSession: "s", workspace: "/w", role, model: null });
    b.install = true;
    const input: Record<string, unknown> = {};
    bindLaunch(input, b);
    const got = readBinding({ [BINDINGS_ENV]: JSON.stringify(input.extensionBindings) });
    assert.equal(got?.role, role);
    assert.equal(got?.install, true);
    const none = readBinding({ [BINDINGS_ENV]: JSON.stringify({ "pi-foreman/1": { foremanSession: "s", role, launchId: "l", install: "yes" } }) });
    assert.equal(none?.install, undefined);
  });
}
