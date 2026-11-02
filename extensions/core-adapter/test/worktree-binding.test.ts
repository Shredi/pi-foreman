import { test } from "node:test";
import assert from "node:assert/strict";
import { BINDINGS_ENV, bindLaunch, checkoutEnv, readBinding, recordUsageLaunch } from "../usage.ts";
import type { LaunchBinding } from "../usage.ts";

function roundTrip(worktree: boolean): LaunchBinding | null {
  const b = recordUsageLaunch(new Map(), { foremanSession: "fs1", workspace: "/w/foreman", role: "builder", model: null });
  if (worktree) b.worktree = true;
  const input: Record<string, unknown> = {};
  bindLaunch(input, b);
  return readBinding({ [BINDINGS_ENV]: JSON.stringify(input.extensionBindings) });
}

test("worktree: true round-trips through the launch binding", () => {
  assert.equal(roundTrip(true)?.worktree, true);
});

test("a binding without worktree has no worktree field", () => {
  const b = roundTrip(false);
  assert.ok(b);
  assert.equal("worktree" in b, false);
});

test("checkoutEnv exports the foreman checkout for a worktree binding only", () => {
  assert.deepEqual(checkoutEnv(roundTrip(true)), { FOREMAN_CHECKOUT: "/w/foreman" });
  assert.deepEqual(checkoutEnv(roundTrip(false)), {});
  assert.deepEqual(checkoutEnv(null), {});
});
