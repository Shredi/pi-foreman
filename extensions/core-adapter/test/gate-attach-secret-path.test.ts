import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDecide, baseFloorEnv } from "../gate.ts";

const deps = { env: (cwd: string) => baseFloorEnv(cwd) };
const home = process.env.HOME ?? "/root";

for (const tool of ["pr_attach", "pr_create"]) {
  test(`${tool}: a secret path in attach[].path is floor-denied`, () => {
    const r = gateDecide(tool, { attach: [{ path: `${home}/.ssh/id_ed25519` }], caption: "x", title: "t", body: "b" }, process.cwd(), deps);
    assert.ok(r && "block" in r);
  });
  test(`${tool}: a command-like or path-like caption is not flagged`, () => {
    const text = `see ${home}/.ssh/id_ed25519 and run \`git push --force\``;
    assert.equal(gateDecide(tool, { attach: [{ path: "a.png", caption: text }], caption: text, title: text, body: text }, process.cwd(), deps), undefined);
  });
}
