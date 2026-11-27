// D189a: a no-change builder end withdraws the revision only when no other builder still runs in that checkout.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { World } from "./_hsrig.ts";
import { build, end, launch, settle, setup, tick } from "./_hsrig.ts";

const lastEntry = (w: World) => w.ceremonyEntries().at(-1)!.data as { gate?: Record<string, unknown> };
async function marked(w: World): Promise<void> {
  const stop = Date.now() + 8000;
  while (Date.now() < stop && Object.keys((lastEntry(w).gate?.passMarks ?? {}) as object).length < 1) await tick(50);
  assert.ok(Object.keys((lastEntry(w).gate?.passMarks ?? {}) as object).length >= 1, "pass mark persisted");
}
const markCwd = (w: World): string => (Object.values((lastEntry(w).gate?.passMarks ?? {}) as Record<string, { cwd: string }>)[0]).cwd;

async function twoBuilders(t: Parameters<typeof setup>[0]) {
  const { a, w } = await setup(t, { world: { realSnapshot: true } });
  await build(a);
  await marked(w);
  await tick(300);
  const t1 = await launch(a, "builder", "look around");
  assert.equal(t1.blocked, null);
  const t2 = await launch(a, "builder", "write code");
  assert.equal(t2.blocked, null);
  return { a, w, t1, t2 };
}

test("builder 1 ends unchanged while builder 2 still runs, then builder 2 writes code: the finish asks for a review", async (t) => {
  const { a, w, t1, t2 } = await twoBuilders(t);
  await end(a, t1, "builder", "done, nothing to change");
  await tick(300);
  fs.writeFileSync(path.join(markCwd(w), "code.ts"), "export const x = 1;\n");
  await end(a, t2, "builder", "done");
  await tick(300);
  assert.match(await settle(a), /review/i);
});

test("builder 2 ends first with code, builder 1 ends unchanged after: the finish asks for a review", async (t) => {
  const { a, w, t1, t2 } = await twoBuilders(t);
  fs.writeFileSync(path.join(markCwd(w), "code.ts"), "export const x = 1;\n");
  await end(a, t2, "builder", "done");
  await tick(300);
  await end(a, t1, "builder", "done, nothing to change");
  await tick(300);
  assert.match(await settle(a), /review/i);
});

test("two builders both end unchanged: the revision is withdrawn", async (t) => {
  const { a, t1, t2 } = await twoBuilders(t);
  await end(a, t1, "builder", "done");
  await tick(300);
  await end(a, t2, "builder", "done");
  await tick(300);
  assert.equal(await settle(a), "");
});
