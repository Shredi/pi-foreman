import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, trackedCommentsFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;

test("more fetched comments than the cap: the newest (first of a newest-first list) are stored, with bot and state", async () => {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prsnewest-"));
  // pr_ops sorts newest first: c0 is the newest
  const fetched = Array.from({ length: 130 }, (_, i) => ({ id: `c${i}`, kind: "issue", author: "bob", body: "x", bot: i === 0 }));
  fetched[1] = { ...fetched[1], kind: "review_summary", state: "approved" } as (typeof fetched)[number];
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => T0,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op) => {
      if (op === "pr_batch") {
        const pr = { repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", runs: [] };
        return { kind: "ran", result: { prs: [pr], errors: [] } } as SafeOpOutcome;
      }
      return { kind: "ran", result: { comments: fetched } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  await pollPrs(deps);
  const c = JSON.parse(fs.readFileSync(trackedCommentsFile(agentDir), "utf8")).prs["acme/app#1"].comments;
  assert.equal(c.length, 100);
  assert.equal(c[0].id, "c0");
  assert.equal(c[0].bot, true);
  assert.equal(c[1].state, "approved");
  assert.equal(c[99].id, "c99");
});
