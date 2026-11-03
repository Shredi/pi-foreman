import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, readStoreEntry, trackedCommentsFile, trackedFile, trackedStateFile } from "../prstore.ts";
import { resolvePython } from "../python.ts";
import { runSafeOp } from "../safeops.ts";
import { defaultSpawner } from "../spawn.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE = path.join(PKG, "tests", "fixtures", "fake_pr_host.py");
const win = process.platform === "win32";

const j = (v: unknown): string => JSON.stringify(v);
const gqlPr = (n: number, state: string, over: Record<string, unknown> = {}) => ({
  pullRequest: { number: n, url: `https://github.com/acme/lib/pull/${n}`, title: `T${n}`, state, isDraft: false, mergeable: "MERGEABLE", reviewDecision: null, headRefName: "feat", headRefOid: "abc1234567", baseRefName: "main", updatedAt: "2026-01-02T00:00:00Z", headRepository: { nameWithOwner: "acme/lib" }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, ...over },
});

/** gh shims (sh and .cmd, like tests/fixtures/pr_host_shims.py) over the fake host, in a directory of their own. */
function shimDir(python: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-fakehost-bin-"));
  const exe = python.replace(/\\/g, "/");
  const fake = FAKE.replace(/\\/g, "/");
  fs.writeFileSync(path.join(d, "gh"), `#!/bin/sh\nexec "${exe}" "${fake}" gh "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(d, "gh.cmd"), `@echo off\r\n"${exe}" "${fake}" gh %*\r\n`);
  return d;
}

async function run(inGitRepo: boolean): Promise<void> {
  clearStoreCache();
  const res = await resolvePython({ configPath: null, envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
  if (!res.ok) return; // no Python >= 3.13 here: nothing to run the real safe_ops.py with
  const python = res.info.executable;
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "pf-fakehost-"));
  fs.writeFileSync(
    path.join(host, "scenario.json"),
    j({
      "gh api graphql": { stdout: j({ data: { r0: gqlPr(1, "OPEN"), r1: gqlPr(2, "MERGED") } }) },
      "gh pr view": { stdout: j({ comments: [{ id: "IC1", author: { login: "bob" }, createdAt: "2026-01-02T00:00:00Z", body: "hello" }], reviews: [] }) },
      "gh api": { stdout: "[]" },
    }),
  );
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pf-fakehost-agent-"));
  if (inGitRepo) execFileSync("git", ["init", "-q", base]);
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(agentDir);
  await addTracked(agentDir, "acme/lib", 1);
  await addTracked(agentDir, "acme/lib", 2);
  const env = Object.fromEntries(Object.entries({ ...process.env, FAKE_PR_HOST_DIR: host, PATH: `${shimDir(python)}${path.delimiter}${process.env.PATH ?? ""}` }).filter((e): e is [string, string] => typeof e[1] === "string"));
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: Date.now,
    resolve: async () => res,
    loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: (py) => (op, args) => runSafeOp({ python: py, script: path.join(PKG, "scripts", "safe_ops.py"), op, args, cwd: agentDir, config: { prHost: "gh" }, env, spawner: defaultSpawner, timeoutMs: 120_000, repoless: true }),
    refresh: async () => "refreshed",
  };
  const r = await pollPrs(deps);
  assert.equal(r.error, undefined);
  assert.deepEqual({ tracked: r.tracked, dropped: r.dropped }, { tracked: 2, dropped: 1 });
  const open = readStoreEntry(agentDir, { host: "github.com", repo: "acme/lib", n: 1 }, Date.now(), true);
  assert.equal(open.kind, "entry");
  if (open.kind === "entry") {
    assert.equal(open.snap.state, "open");
    assert.equal(open.snap.head, "abc1234567");
    assert.deepEqual(open.snap.comments?.map((c) => c.id), ["IC1"]);
  }
  const merged = readStoreEntry(agentDir, { host: "github.com", repo: "acme/lib", n: 2 }, Date.now(), true);
  assert.equal(merged.kind === "entry" && merged.snap.state, "merged");
  const left = (JSON.parse(fs.readFileSync(trackedFile(agentDir), "utf8")).prs as { number: number }[]).map((l) => l.number);
  assert.deepEqual(left, [1]);
  assert.equal(fs.existsSync(trackedStateFile(agentDir)), true);
  const comments = JSON.parse(fs.readFileSync(trackedCommentsFile(agentDir), "utf8")).prs;
  assert.deepEqual(Object.keys(comments), ["acme/lib#1"]);
  assert.ok(win || fs.existsSync(path.join(host, "calls.jsonl")));
}

test("end to end through safe_ops.py and the fake gh: one open and one merged PR, comments stored, one drop (agent dir outside a repo)", async () => {
  await run(false);
});

test("the same inside a git work tree", async () => {
  await run(true);
});
