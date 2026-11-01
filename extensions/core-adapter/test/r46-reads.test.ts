// R46 item 5: per-launch child read allowance from size.files (perFile, max) or an explicit `reads` field, carried in the launch binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { childReadLimits, launchReadAllowance } from "../childreads.ts";
import { takeLaunchFlags } from "../sizing.ts";
import { bindLaunch, readBinding, recordUsageLaunch, BINDINGS_ENV } from "../usage.ts";

const cfg = (childReads?: unknown) => (childReads === undefined ? {} : { ceremony: { childReads } });

test("size.files 10 raises the builder deny to 75 and the warn by the same amount", () => {
  const c = cfg({ builder: { warn: 20, deny: 40 } });
  const a = launchReadAllowance(c, "builder", { files: 10 });
  assert.equal(a.allowance, 75);
  assert.deepEqual(childReadLimits(c, "builder", a.allowance), { warn: 55, deny: 75 });
});

test("up to 3 files and no reads leave the limits as configured", () => {
  const c = cfg({ builder: { warn: 20, deny: 40 } });
  assert.equal(launchReadAllowance(c, "builder", { files: 3 }).allowance, undefined);
  assert.deepEqual(childReadLimits(c, "builder"), { warn: 20, deny: 40 });
});

test("the coded defaults: builder perFile 5, reviewer perFile 2, max 120", () => {
  assert.equal(launchReadAllowance({}, "builder", { files: 10 }).allowance, 75);
  assert.equal(launchReadAllowance({}, "reviewer", { files: 10 }).allowance, 30 + 2 * 7);
  assert.equal(launchReadAllowance({}, "builder", { files: 100 }).allowance, 120);
  assert.equal(childReadLimits({}, "builder", 500)?.deny, 120);
});

test("perFile and max come from ceremony.childReads.<role>", () => {
  const c = cfg({ builder: { warn: 20, deny: 40, perFile: 10, max: 60 } });
  assert.equal(launchReadAllowance(c, "builder", { files: 6 }).allowance, 60); // 40 + 10 * 3 = 70, clamped to 60
  assert.equal(launchReadAllowance(c, "builder", { files: 5 }).allowance, 60);
  assert.equal(launchReadAllowance(c, "builder", { files: 4 }).allowance, 50);
});

test("an explicit reads is clamped to max and says so; it beats the size formula", () => {
  const c = cfg({ builder: { warn: 20, deny: 40 } });
  assert.deepEqual(launchReadAllowance(c, "builder", { reads: 200, files: 10 }), { allowance: 120, clamped: true });
  assert.deepEqual(launchReadAllowance(c, "builder", { reads: 50, files: 10 }), { allowance: 50 });
  assert.deepEqual(childReadLimits(c, "builder", 50), { warn: 30, deny: 50 });
});

test("a role without limits has no allowance", () => {
  assert.equal(launchReadAllowance(cfg({ reviewer: { warn: 15, deny: 30 } }), "builder", { reads: 50 }).allowance, undefined);
  assert.equal(childReadLimits(cfg({ reviewer: { warn: 15, deny: 30 } }), "builder", 50), null);
});

test("takeLaunchFlags strips reads and install, keeps them for the roles that use them", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", reads: 60, install: true };
  const t = takeLaunchFlags(input);
  assert.equal(t.error, undefined);
  assert.equal("reads" in input || "install" in input, false);
  assert.deepEqual(t.entries.get(input), { reads: 60, install: true });
});

test("takeLaunchFlags drops a flag the role does not use, with a note", () => {
  const rev: Record<string, unknown> = { agent: "reviewer", task: "t", install: true, reads: 40 };
  const t = takeLaunchFlags(rev);
  assert.deepEqual(t.entries.get(rev), { reads: 40 });
  assert.match(t.notes.join("\n"), /install/);
  const exp: Record<string, unknown> = { agent: "explorer", task: "t", reads: 40 };
  const e = takeLaunchFlags(exp);
  assert.deepEqual(e.entries.get(exp), {});
  assert.match(e.notes.join("\n"), /reads/);
});

test("takeLaunchFlags rejects malformed values", () => {
  for (const bad of [{ reads: 0 }, { reads: 1.5 }, { reads: "9" }, { install: "yes" }, { install: 1 }]) {
    const t = takeLaunchFlags({ agent: "builder", task: "t", ...bad });
    assert.match(t.error ?? "", /launch refused \[launch_flag_invalid\]/, JSON.stringify(bad));
  }
});

test("takeLaunchFlags on a group strips the fields and keeps the config defaults, saying so", () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "builder", task: "a", reads: 60, install: true }, { agent: "reviewer", task: "b" }] };
  const t = takeLaunchFlags(input);
  const first = (input.tasks as Record<string, unknown>[])[0];
  assert.equal("reads" in first || "install" in first, false);
  assert.equal(t.group, true);
  assert.match(t.notes.join("\n"), /group launch/);
});

for (const role of ["builder", "reviewer"]) {
  test(`${role} launch binding carries reads and the child reads it back`, () => {
    const b = recordUsageLaunch(new Map(), { foremanSession: "s", workspace: "/w", role, model: null });
    b.reads = 75;
    const input: Record<string, unknown> = {};
    bindLaunch(input, b);
    assert.equal(readBinding({ [BINDINGS_ENV]: JSON.stringify(input.extensionBindings) })?.reads, 75);
    const bad = readBinding({ [BINDINGS_ENV]: JSON.stringify({ "pi-foreman/1": { foremanSession: "s", role, launchId: "l", reads: -3 } }) });
    assert.equal(bad?.reads, undefined);
  });
}
