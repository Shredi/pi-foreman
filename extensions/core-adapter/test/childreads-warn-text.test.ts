// D97: the 50 % read warning of an explorer or reviewer says how many reads remain and that the child may continue;
// the launch receipt names the effective read deny. Builder texts and the deny text are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildReads } from "../childreads.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const warnOf = (role: string): string => {
  const c = new ChildReads();
  for (let i = 1; i < 3; i++) c.check("read", String(i), {}, { warn: 3, deny: 10, role });
  return (c.check("read", "3", {}, { warn: 3, deny: 10, role }) as { text: string }).text;
};

for (const role of ["reviewer", "explorer"]) {
  test(`${role} warn text names the remaining reads and says to continue`, () => {
    const text = warnOf(role);
    assert.equal(text, "pi-foreman: read budget 3 of 10 read calls; 7 left. Continue the task; at 10 further reads are refused.");
    assert.doesNotMatch(text, /return your report|Wrap up/i);
  });
}

test("deny text of a reviewer and a builder is unchanged", () => {
  const deny = (role: string) => {
    const c = new ChildReads();
    c.check("read", "1", {}, { warn: 1, deny: 1, role });
    return (c.check("read", "2", {}, { warn: 1, deny: 1, role }) as { reason: string }).reason;
  };
  assert.equal(deny("reviewer"), `pi-foreman: [child_read_budget_exceeded] 1 read calls (limit 1). Stop reading: return your report now with what you have. If you cannot finish, start it with "STATUS: stuck" and say what is missing.`);
  assert.equal(deny("builder"), "pi-foreman: [child_read_budget_exceeded] 1 read calls (limit 1). Further reads are refused. Make your edits now with what you know. If you cannot edit without more reads, end with STATUS: stuck and say what is missing.");
});

test("builder warn text is unchanged", () => {
  assert.equal(warnOf("builder"), "pi-foreman: read budget 3 of 10 read calls. Stop reading and write the code now with what you know; at 10 further reads are refused.");
});

test("the launch receipt of a reviewer names the effective read deny", async (t) => {
  const r = await r11Rig(t, {}, { ctx: reviewAllowOpts().ctx, config: { ...reviewAllowOpts().config }, deps: { mcpChild: { resolveRoot: () => null } } });
  const input = { agent: "reviewer", task: "check it", reads: 50 };
  const { id, res } = await r.launch(input);
  assert.equal(res, undefined);
  const text = JSON.stringify(await r.started(id, input, `run-${id}`));
  assert.match(text, /reads: 50 \(warn at 35\)/);
});
