// Positive control of the fake `gh` that _hermetic-env.mjs puts first on PATH: a `gh` call made by the code under test lands
// in the fake's log (so it never reaches the real gh or GitHub), also from an adapter session with the open-PRs refresher on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OpenPrsRefresher, realGh } from "../openprs.ts";
import { resolveGh } from "../wait.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { tick, world } from "./_r46world.ts";

const LOG = process.env.FOREMAN_FAKE_GH_LOG;
const skip = LOG ? false : "the fake gh is set by _hermetic-env.mjs (test:node) and not on Windows";
const calls = (): string[] => fs.readFileSync(LOG!, "utf8").split("\n").filter(Boolean);

test("gh resolves to the fake, not to a real gh", { skip }, () => {
  assert.equal(resolveGh(process.cwd()), path.join(path.dirname(LOG!), "gh"));
});

test("realGh() reaches the fake: the call is recorded and fails", { skip }, async () => {
  const before = calls().length;
  await assert.rejects(realGh(process.cwd())(["api", "graphql", "-f", "q=control"]));
  assert.deepEqual(calls().slice(before), ["api graphql -f q=control"]);
});

test("the open-PRs refresher goes through the fake and records the failure in its file", { skip }, async () => {
  const dir = mkTestTmp("r78fg-");
  try {
    const before = calls().length;
    const r = new OpenPrsRefresher({ agentDir: dir, config: () => ({ enabled: true }), gh: realGh(dir) });
    assert.equal(await r.tick(), "failed");
    assert.ok(calls().length > before);
    assert.ok(calls().slice(before).every((c) => c.startsWith("api graphql ")));
  } finally {
    rmTestTmp(dir);
  }
});

test("an adapter session with the refresher on reaches only the fake gh", { skip }, async (t) => {
  const w = world(t);
  const agentDir = path.resolve(w.handoff, "..", "..", "..");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ radar: { openPrs: { enabled: true } } }));
  const before = calls().length;
  await w.adapter();
  for (let i = 0; i < 80 && calls().length === before; i++) await tick(100);
  assert.ok(calls().length > before, "the first refresher tick ran");
  assert.ok(calls().slice(before).every((c) => c.startsWith("api graphql ")));
});
