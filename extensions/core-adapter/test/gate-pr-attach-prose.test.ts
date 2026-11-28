import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDecide, baseFloorEnv } from "../gate.ts";

// pr_attach is a prose tool like pr_create: its caption is not scanned as a command line.
test("pr_attach caption quoting floor patterns is not floor-denied", () => {
  const deps = { env: (cwd: string) => baseFloorEnv(cwd) };
  assert.equal(gateDecide("pr_attach", { attach: [{ path: "a.png" }], caption: "The floors deny `git push --force` and `npm publish`" }, process.cwd(), deps), undefined);
});
