// D225: `diffBase` narrows an item review's diff; a [high-stakes] or [pre-pr] review covers the whole change, so the launch is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, launch, setup } from "./_hsrig.ts";

const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });

test("a [high-stakes] launch with diffBase is refused; without it the launch is accepted", async (t) => {
  const { a } = await setup(t, { onMain: true });
  await build(a, sized(["design"]));
  const refused = await launch(a, "reviewer", "[high-stakes] review the whole change", { diffBase: "HEAD" });
  assert.match(String(refused.blocked), /diff_base_whole_change/);
  const ok = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(ok.blocked, null, String(ok.blocked));
});

test("a [pre-pr] launch with diffBase is refused", async (t) => {
  const { a } = await setup(t, { onMain: true });
  const refused = await launch(a, "reviewer", "[pre-pr] review the branch", { diffBase: "HEAD" });
  assert.match(String(refused.blocked), /diff_base_whole_change/);
});
