// D102: with more than one host configured the poll removes the tracked-list lines that carry no `host` once (the state file's `hostlessDroppedAt` marks it done);
// with one host nothing is dropped. A line with a host, and its state, stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { clearStoreCache, readTracked, trackedFile, trackedStateFile, writeTracked } from "../prstore.ts";
import { resolveGithubHosts } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const GHE = "ghe.example.test";
const STEP = 30_000;

type Row = Record<string, unknown>;
const rowOf = (repo: string, number: number): Row => ({ repo, number, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: `https://github.com/${repo}/pull/${number}`, title: "t", draft: false, headRefName: "feat", headRepo: repo, runs: [{ id: "ci", name: "ci", bucket: "passed", url: "x" }] });

function setup(hosts: string[]) {
  clearStoreCache();
  const agentDir = mkTestTmp("pf-prhostless-");
  const clock = { t: T0 };
  const config = { tools: { prGithubHosts: hosts } };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => (op === "pr_batch" ? ({ kind: "ran", result: { prs: (args.prs as { repo: string; n: number }[]).map((e) => rowOf(e.repo, e.n)), errors: [] } } as SafeOpOutcome) : ({ kind: "ran", result: { comments: [] } } as SafeOpOutcome)),
    refresh: async () => "refreshed",
    githubHosts: resolveGithubHosts,
  };
  const write = (lines: unknown[]) => writeTracked(agentDir, lines);
  const poll = async () => {
    clock.t += STEP;
    const res = await pollPrs(deps);
    return { res, state: JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")), lines: JSON.parse(fs.readFileSync(trackedFile(agentDir), "utf8")).prs as Record<string, unknown>[] };
  };
  return { agentDir, write, poll, clock };
}

test("two hosts: host-less lines are removed once, the marker is written, a host-less line added later stays", async () => {
  const h = setup(["github.com", GHE]);
  try {
    h.write([
      { repo: "acme/app", number: 1, addedAt: T0 - 1000 },
      { repo: "acme/app", number: 2, addedAt: T0 - 1000, host: "github.com" },
      { repo: "acme/app", number: 3, addedAt: T0 - 1000, host: GHE },
    ]);
    const a = await h.poll();
    assert.deepEqual(a.lines.map((l) => [l.number, l.host]), [[2, "github.com"], [3, GHE]]);
    assert.deepEqual(Object.keys(a.state.prs).sort(), ["acme/app#2", `${GHE}/acme/app#3`]);
    assert.equal(a.state.hostlessDroppedAt, T0 + STEP);
    assert.match(a.res.error ?? "", /removed 1 tracked PR line without a host/);
    h.write([...a.lines, { repo: "acme/app", number: 4, addedAt: h.clock.t }]);
    const b = await h.poll();
    assert.deepEqual(b.lines.map((l) => l.number), [2, 3, 4], "a later host-less line stays");
    assert.ok("acme/app#4" in b.state.prs, "and is polled as github.com");
    assert.equal(b.state.hostlessDroppedAt, T0 + STEP, "the marker is kept by every rewrite");
    assert.doesNotMatch(b.res.error ?? "", /removed/);
  } finally {
    rmTestTmp(h.agentDir);
  }
});

test("two hosts: a github.com line with a host keeps its state when a host-less twin of the same key is dropped; a drop that removes nothing still writes the marker", async () => {
  const h = setup(["github.com", GHE]);
  try {
    h.write([{ repo: "acme/app", number: 1, addedAt: T0 - 1000 }, { repo: "acme/app", number: 1, addedAt: T0 - 900, host: "github.com" }]);
    const a = await h.poll();
    assert.deepEqual(a.lines.map((l) => l.host), ["github.com"]);
    assert.ok("acme/app#1" in a.state.prs);
    assert.equal(a.state.hostlessDroppedAt, T0 + STEP);
  } finally {
    rmTestTmp(h.agentDir);
  }
  const g = setup(["github.com", GHE]);
  try {
    g.write([{ repo: "acme/app", number: 2, addedAt: T0 - 1000, host: GHE }]);
    const a = await g.poll();
    assert.equal(a.state.hostlessDroppedAt, T0 + STEP);
    assert.doesNotMatch(a.res.error ?? "", /removed/, "nothing removed: no line");
  } finally {
    rmTestTmp(g.agentDir);
  }
});

test("one host: host-less lines stay and no marker is written", async () => {
  const h = setup(["github.com"]);
  try {
    h.write([{ repo: "acme/app", number: 1, addedAt: T0 - 1000 }]);
    const a = await h.poll();
    assert.equal(readTracked(h.agentDir).kind, "ok");
    assert.deepEqual(a.lines.map((l) => l.host), [undefined]);
    assert.ok("acme/app#1" in a.state.prs);
    assert.equal(a.state.hostlessDroppedAt, undefined);
  } finally {
    rmTestTmp(h.agentDir);
  }
});
