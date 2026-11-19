// The adapter's real tool_call handler (rig `_r11rig.ts`): a bash call with an empty, whitespace-only, missing or non-string command is refused by
// the handler itself (the gate lets such lines through).
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0];

test("bash: the handler refuses an empty, whitespace-only, missing and non-string command", async (t: T) => {
  const c = await r11Rig(t, {}, { ctx: { [RIG_PERMISSIONS]: { allow: ["bash"] } }, config: { presence: { enabled: false } } });
  for (const input of [{ command: "" }, { command: "   " }, {}, { command: 7 }, { command: ["rm", "x"] }]) {
    const res = await c.call("bash", input);
    assert.equal(res?.block, true, `${JSON.stringify(input)}: ${JSON.stringify(res)}`);
    assert.match(String(res?.reason), /empty command|no command|type /);
  }
});
