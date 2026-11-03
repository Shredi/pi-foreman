import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, trackedFile, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;

const row = (repo: string, n: number, state: string): Record<string, unknown> => ({ repo, number: n, state, mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1", url: `https://github.com/${repo}/pull/${n}`, title: `t${n}`, draft: false, headRefName: "feat", headRepo: repo, runs: [] });

/** A poll over one PR `acme/a#1` in state `state`; `during` runs inside the pr_batch call (the poll holds the state lock). */
async function world(state: string, during: (agentDir: string) => Promise<void> | void = () => {}) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prspoll-races-"));
  const clock = { t: T0 };
  await addTracked(agentDir, "acme/a", 1, () => T0 - 1000);
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op) => {
      if (op === "pr_batch") {
        await during(agentDir);
        return { kind: "ran", result: { prs: [row("acme/a", 1, state)], errors: [] } } as SafeOpOutcome;
      }
      return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
  };
  return { deps, agentDir, clock };
}

const list = (dir: string) => (JSON.parse(fs.readFileSync(trackedFile(dir), "utf8")).prs as { repo: string; number: number }[]).map((l) => `${l.repo}#${l.number}`);

test("a discarded write drops nothing: the state lock taken over mid-run", async () => {
  const w = await world("merged", (dir) => fs.writeFileSync(`${trackedStateFile(dir)}.lock`, "other-run-token"));
  const r = await pollPrs(w.deps);
  assert.equal(r.dropped, 0);
  assert.equal(fs.existsSync(trackedStateFile(w.agentDir)), false, "no state written");
  assert.deepEqual(list(w.agentDir), ["acme/a#1"]);
});

test("a busy tracked lock on a drop keeps the key; the next run polls and drops it", async () => {
  const w = await world("merged");
  const lock = `${trackedFile(w.agentDir)}.lock`;
  fs.writeFileSync(lock, "other"); // younger than the stale age against the fake clock
  const r = await pollPrs(w.deps);
  assert.equal(r.dropped, 0);
  assert.deepEqual(list(w.agentDir), ["acme/a#1"]);
  const st = JSON.parse(fs.readFileSync(trackedStateFile(w.agentDir), "utf8"));
  assert.equal(st.prs["acme/a#1"].snap.state, "merged", "the ending is in the store");
  fs.unlinkSync(lock);
  w.clock.t += 60_000;
  const r2 = await pollPrs(w.deps);
  assert.equal(r2.tracked, 1, "the key was polled again");
  assert.equal(r2.dropped, 1);
  assert.deepEqual(list(w.agentDir), []);
});

test("an add during the poll survives the drop", async () => {
  const w = await world("merged", async (dir) => {
    assert.equal(await addTracked(dir, "acme/b", 2, () => T0), "added");
  });
  const r = await pollPrs(w.deps);
  assert.equal(r.dropped, 1);
  assert.deepEqual(list(w.agentDir), ["acme/b#2"]);
});
