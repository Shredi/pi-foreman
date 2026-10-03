import { test } from "node:test";
import assert from "node:assert/strict";
import { forceDetached } from "../detach.ts";

test("async:false becomes true and is reported as an override", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", async: false };
  assert.equal(forceDetached(input), true);
  assert.deepEqual(input, { agent: "explorer", task: "t", async: true });
});

test("missing async is set to true without an override notice", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t" };
  assert.equal(forceDetached(input), false);
  assert.equal(input.async, true);
  const already: Record<string, unknown> = { agent: "explorer", task: "t", async: true };
  assert.equal(forceDetached(already), false);
  assert.deepEqual(already, { agent: "explorer", task: "t", async: true });
});

test("foregroundOnly is removed", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", foregroundOnly: true };
  assert.equal(forceDetached(input), true);
  assert.deepEqual(input, { agent: "explorer", task: "t", async: true });
});

test("tasks, chain and chain parallel entries lose async:false and foregroundOnly, nothing is added", () => {
  const input: Record<string, unknown> = {
    tasks: [{ agent: "a", task: "x", async: false }, { agent: "b", task: "y" }],
    chain: [{ agent: "c", foregroundOnly: true }, { parallel: [{ agent: "d", task: "z", async: false }] }],
  };
  assert.equal(forceDetached(input), true);
  assert.deepEqual(input, {
    async: true,
    tasks: [{ agent: "a", task: "x", async: true }, { agent: "b", task: "y" }],
    chain: [{ agent: "c" }, { parallel: [{ agent: "d", task: "z", async: true }] }],
  });
});

test("management calls only lose an explicit async:false", () => {
  const status: Record<string, unknown> = { action: "status", id: "r1" };
  assert.equal(forceDetached(status), false);
  assert.deepEqual(status, { action: "status", id: "r1" });
  const resume: Record<string, unknown> = { action: "resume", id: "r1", async: false };
  assert.equal(forceDetached(resume), true);
  assert.equal(resume.async, true);
});
