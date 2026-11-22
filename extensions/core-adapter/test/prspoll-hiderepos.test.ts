import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { openPrsFile } from "../openprs.ts";
import { addTracked, clearStoreCache, storeKey, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { trackedTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;

type Row = Record<string, unknown>;
const row = (repo: string, n: number, o: Row = {}): Row => ({ repo, number: n, state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1", url: `https://github.com/${repo}/pull/${n}`, title: `t${n}`, draft: false, headRefName: "feat", headRepo: repo, runs: [{ id: "1", name: "ci", bucket: "passed", url: "x" }], ...o });

function setup(hideRepos: unknown, refresh: "refreshed" | "fresh" = "refreshed") {
  clearStoreCache();
  const agentDir = trackedTmp("pf-hide-");
  const rows = new Map<string, Row>();
  const clock = { t: T0 };
  const cfg = { value: { radar: { openPrs: { hideRepos } } } as Record<string, unknown> };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => (clock.t += 30_000),
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: cfg.value, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      const prs: Row[] = [];
      if (op === "pr_batch") for (const p of args.prs as { repo: string; n: number }[]) { const r = rows.get(storeKey(p.repo, p.n)); if (r) prs.push(r); }
      return { kind: "ran", result: op === "pr_batch" ? { prs, errors: [] } : { comments: [] } } as SafeOpOutcome;
    },
    refresh: async () => refresh,
  };
  return { deps, rows, agentDir, cfg };
}

const state = (dir: string) => JSON.parse(fs.readFileSync(trackedStateFile(dir), "utf8"));

async function twoRepos(h: ReturnType<typeof setup>) {
  for (const [repo, n] of [["acme/archive", 1], ["acme/widgets", 2]] as const) {
    await addTracked(h.agentDir, repo, n, () => T0 - 1000);
    h.rows.set(`${repo}#${n}`, row(repo, n));
  }
}

test("tracked entries of a matching repo get hiddenRepo; a config change unmarks", async () => {
  const h = setup(["acme/arch*"]);
  await twoRepos(h);
  await pollPrs(h.deps);
  let prs = state(h.agentDir).prs;
  assert.equal(prs["acme/archive#1"].hiddenRepo, true);
  assert.equal("hiddenRepo" in prs["acme/widgets#2"], false);
  assert.equal(prs["acme/archive#1"].snap.state, "open", "the hidden PR is still polled");
  h.cfg.value = { radar: { openPrs: { hideRepos: [] } } };
  await pollPrs(h.deps);
  prs = state(h.agentDir).prs;
  assert.equal("hiddenRepo" in prs["acme/archive#1"], false);
});

test("an ended entry is marked and unmarked like the others", async () => {
  const h = setup([]);
  await twoRepos(h);
  h.rows.set("acme/archive#1", row("acme/archive", 1, { state: "merged" }));
  await pollPrs(h.deps);
  assert.equal("hiddenRepo" in state(h.agentDir).prs["acme/archive#1"], false);
  h.cfg.value = { radar: { openPrs: { hideRepos: ["acme/*"] } } };
  await pollPrs(h.deps);
  const prs = state(h.agentDir).prs;
  assert.equal(prs["acme/archive#1"].endedAt !== undefined && prs["acme/archive#1"].hiddenRepo, true);
  assert.equal(prs["acme/widgets#2"].hiddenRepo, true);
});

test("an empty list marks nothing", async () => {
  const h = setup([]);
  await twoRepos(h);
  const r = await pollPrs(h.deps);
  assert.equal(r.error, undefined);
  for (const e of Object.values(state(h.agentDir).prs) as Row[]) assert.equal("hiddenRepo" in e, false);
});

test("a malformed value marks nothing and the poll names the key", async () => {
  const h = setup("acme/*");
  await twoRepos(h);
  const r = await pollPrs(h.deps);
  assert.match(r.error ?? "", /^radar\.openPrs\.hideRepos: /);
  for (const e of Object.values(state(h.agentDir).prs) as Row[]) assert.equal("hiddenRepo" in e, false);
});

test("open-prs.json is re-marked on a poll whose search is fresh", async () => {
  const h = setup(["acme/archive"], "fresh");
  const file = openPrsFile(h.agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mk = (repo: string, n: number) => ({ repo, number: n, title: "t", url: `https://example.test/${repo}/pull/${n}`, state: "open", author: "o", checks: [] });
  fs.writeFileSync(file, JSON.stringify({ v: 1, fetchedAt: "2026-01-01T00:00:00Z", checkedAt: "2026-01-01T00:00:00Z", openPrs: [mk("acme/archive", 1), mk("acme/widgets", 2)] }));
  const r = await pollPrs(h.deps);
  assert.equal(r.searched, false);
  const prs = JSON.parse(fs.readFileSync(file, "utf8")).openPrs;
  assert.equal(prs[0].hiddenRepo, true);
  assert.equal("hiddenRepo" in prs[1], false);
});
