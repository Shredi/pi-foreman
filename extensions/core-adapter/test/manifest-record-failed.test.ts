import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEntries, type ManifestEntry } from "../manifest.ts";

const o = { session: "fm", owner: "L1", stateDir: "/st" };
const es: ManifestEntry[] = [
  { kind: "worktree", path: "/w/wt", branch: "b" },
  { kind: "scratch", path: "/s" },
];

test("manifest-record-failed: a resolved ok:false reports its first line once per entry; later entries are still recorded", async () => {
  const calls: string[][] = [];
  const failed: [ManifestEntry, string][] = [];
  await recordEntries(es, o, async (a) => {
    calls.push(a);
    return { ok: false, text: "boom\nmore" };
  }, (e, why) => failed.push([e, why]));
  assert.equal(calls.length, 2, "a failed record never stops the next");
  assert.deepEqual(failed, [[es[0], "boom"], [es[1], "boom"]]);
});

test("manifest-record-failed: a throw is reported with its message and no error escapes", async () => {
  const failed: [ManifestEntry, string][] = [];
  await recordEntries(es, o, async () => {
    throw new Error("no python");
  }, (e, why) => failed.push([e, why]));
  assert.deepEqual(failed, [[es[0], "no python"], [es[1], "no python"]]);
});

test("manifest-record-failed: a failing reporter does not escape either", async () => {
  const calls: string[][] = [];
  await recordEntries(es, o, async (a) => {
    calls.push(a);
    return { ok: false, text: "boom" };
  }, () => {
    throw new Error("trace closed");
  });
  assert.equal(calls.length, 2);
});

test("manifest-record-failed: a successful or legacy (undefined) record is not reported", async () => {
  const failed: string[] = [];
  await recordEntries(es, o, async () => ({ ok: true, text: "recorded" }), (_e, why) => failed.push(why));
  await recordEntries(es, o, async () => undefined, (_e, why) => failed.push(why));
  assert.deepEqual(failed, []);
});
