// `foreman prs poll` with tools.prGithubHosts through the real safe_ops.py and the fake gh (tests/fixtures/fake_pr_host.py):
// two hosts with the same o/r#7, the unset and invalid key (no gh call, one tracker error), a tracked line on an unlisted host.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, readStoreEntry, storeKey, trackedFile, trackedStateFile } from "../prstore.ts";
import { resolveGithubHosts } from "../prhost.ts";
import { resolvePython } from "../python.ts";
import { runSafeOp } from "../safeops.ts";
import { defaultSpawner } from "../spawn.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE = path.join(PKG, "tests", "fixtures", "fake_pr_host.py");
const GHE = "ghe.example.test";
const win = process.platform === "win32";

const j = (v: unknown): string => JSON.stringify(v);
const gqlPr = (n: number, host: string, title: string) => ({
  pullRequest: { number: n, url: `https://${host}/acme/lib/pull/${n}`, title, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: null, headRefName: "feat", headRefOid: "abc1234567", baseRefName: "main", updatedAt: "2026-01-02T00:00:00Z", headRepository: { nameWithOwner: "acme/lib" }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
});

function shimDir(python: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ghe-bin-"));
  const exe = python.replace(/\\/g, "/");
  const fake = FAKE.replace(/\\/g, "/");
  fs.writeFileSync(path.join(d, "gh"), `#!/bin/sh\nexec "${exe}" "${fake}" gh "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(d, "gh.cmd"), `@echo off\r\n"${exe}" "${fake}" gh %*\r\n`);
  return d;
}

interface Rig {
  agentDir: string;
  host: string;
  calls: () => { argv: string[] }[];
  deps: (config: Record<string, unknown>, refreshed?: unknown[]) => PollDeps;
}

async function withRig(t: TestContext, fn: (r: Rig) => Promise<void>): Promise<void> {
  clearStoreCache();
  const res = await resolvePython({ configPath: null, envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
  if (!res.ok || win) return void t.skip("no Python >= 3.13 here (or Windows): nothing to run the real safe_ops.py with");
  const python = res.info.executable;
  const dirs: string[] = [];
  try {
    const host = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ghe-"));
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ghe-agent-"));
    const shims = shimDir(python);
    dirs.push(host, agentDir, shims);
    fs.writeFileSync(
      path.join(host, "scenario.json"),
      j({
        "gh api graphql --hostname github.com": { stdout: j({ data: { r0: gqlPr(7, "github.com", "On github") } }) },
        [`gh api graphql --hostname ${GHE}`]: { stdout: j({ data: { r0: gqlPr(7, GHE, "On ghe") } }) },
        "gh pr view": { stdout: j({ comments: [], reviews: [] }) },
        "gh api": { stdout: "[]" },
      }),
    );
    const env = Object.fromEntries(Object.entries({ ...process.env, FAKE_PR_HOST_DIR: host, PATH: `${shims}${path.delimiter}${process.env.PATH ?? ""}` }).filter((e): e is [string, string] => typeof e[1] === "string"));
    const deps = (config: Record<string, unknown>, refreshed: unknown[] = []): PollDeps => ({
      agentDir,
      pkgRoot: PKG,
      now: Date.now,
      resolve: async () => res,
      loadConfig: async () => ({ config, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
      runOp: (py) => (op, args) => runSafeOp({ python: py, script: path.join(PKG, "scripts", "safe_ops.py"), op, args, cwd: agentDir, config: { prHost: "gh" }, env, spawner: defaultSpawner, timeoutMs: 120_000, repoless: true }),
      refresh: async (_c, hosts) => (refreshed.push(hosts), "refreshed"),
      githubHosts: resolveGithubHosts,
    });
    const calls = (): { argv: string[] }[] => {
      const f = path.join(host, "calls.jsonl");
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    };
    await fn({ agentDir, host, calls, deps });
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

test("two hosts, the same acme/lib#7 on each: two store entries, one pr_batch per host with its own --hostname, each entry its own meta", async (t) => {
  await withRig(t, async (r) => {
    await addTracked(r.agentDir, "acme/lib", 7);
    await addTracked(r.agentDir, "acme/lib", 7, undefined, GHE);
    await addTracked(r.agentDir, "acme/lib", 7, undefined, GHE.toUpperCase()); // present: the host is case-insensitive
    const lines = JSON.parse(fs.readFileSync(trackedFile(r.agentDir), "utf8")).prs;
    assert.deepEqual(lines.map((l: Record<string, unknown>) => l.host), [undefined, GHE]); // github.com is written without the field
    const seen: unknown[] = [];
    const res = await pollPrs(r.deps({ tools: { prGithubHosts: ["github.com", GHE.toUpperCase()] } }, seen));
    assert.equal(res.error, undefined);
    assert.equal(res.tracked, 2);
    assert.deepEqual(seen, [{ hosts: ["github.com", GHE] }]);
    const batches = r.calls().filter((c) => c.argv[1] === "api" && c.argv[2] === "graphql").map((c) => c.argv[c.argv.indexOf("--hostname") + 1]);
    assert.deepEqual(batches.sort(), [GHE, "github.com"]);
    const state = JSON.parse(fs.readFileSync(trackedStateFile(r.agentDir), "utf8")).prs;
    assert.deepEqual(Object.keys(state).sort(), ["acme/lib#7", `${GHE}/acme/lib#7`]);
    assert.equal(state["acme/lib#7"].meta.title, "On github");
    assert.equal(state[`${GHE}/acme/lib#7`].meta.title, "On ghe");
    assert.equal(state[`${GHE}/acme/lib#7`].meta.url, `https://${GHE}/acme/lib/pull/7`);
    const hosts = { hosts: ["github.com", GHE] };
    const own = readStoreEntry(r.agentDir, { host: GHE, repo: "acme/lib", n: 7 }, Date.now(), true, hosts);
    const gh = readStoreEntry(r.agentDir, { host: "github.com", repo: "acme/lib", n: 7 }, Date.now(), true, hosts);
    assert.equal(own.kind, "entry");
    assert.equal(gh.kind, "entry");
    assert.equal(storeKey("Acme/Lib", 7, GHE.toUpperCase()), `${GHE}/acme/lib#7`);
  });
});

test("a tracked line on a host that left the list is skipped and reported once; its entry is pruned like a removed line", async (t) => {
  await withRig(t, async (r) => {
    await addTracked(r.agentDir, "acme/lib", 7);
    await addTracked(r.agentDir, "acme/lib", 8, undefined, GHE);
    await addTracked(r.agentDir, "acme/lib", 9, undefined, GHE);
    const res = await pollPrs(r.deps({ tools: { prGithubHosts: ["github.com"] } }));
    assert.equal(res.tracked, 1);
    assert.match(res.error ?? "", /outside tools\.prGithubHosts are skipped \(github\.com\)/);
    assert.equal(r.calls().filter((c) => c.argv.includes(GHE)).length, 0);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(trackedStateFile(r.agentDir), "utf8")).prs), ["acme/lib#7"]);
    assert.equal(JSON.parse(fs.readFileSync(trackedFile(r.agentDir), "utf8")).prs.length, 3); // the lines stay
  });
});

test("the key unset: one tracker error with the plain notice, the refresher gets it, no gh call", async (t) => {
  await withRig(t, async (r) => {
    await addTracked(r.agentDir, "acme/lib", 7);
    const seen: unknown[] = [];
    const res = await pollPrs(r.deps({}, seen));
    assert.equal(res.error, "no GitHub hosts configured: run `foreman setup` (tools.prGithubHosts)");
    assert.equal(res.tracked, 0);
    assert.deepEqual(seen, [{ error: res.error }]);
    assert.deepEqual(r.calls(), []);
    // a watch reads the notice, not TRACKER_DOWN, from an install whose poll wrote nothing
    assert.deepEqual(readStoreEntry(r.agentDir, { host: "github.com", repo: "acme/lib", n: 7 }, Date.now(), true, resolveGithubHosts({})), { kind: "error", error: res.error });
  });
});

test("an invalid list: one tracker error naming the key, nothing polled", async (t) => {
  await withRig(t, async (r) => {
    await addTracked(r.agentDir, "acme/lib", 7);
    for (const [list, text] of [
      [[], "tools.prGithubHosts: is empty"],
      [["github.com", "bad host"], "tools.prGithubHosts: bad host is not a valid host name"],
      [Array.from({ length: 21 }, (_, i) => `h${i}.example.test`), "tools.prGithubHosts: has more than 20 hosts"],
    ] as [string[], string][]) {
      const res = await pollPrs(r.deps({ tools: { prGithubHosts: list } }));
      assert.equal(res.error, text);
      assert.equal(res.tracked, 0);
    }
    assert.deepEqual(r.calls(), []);
  });
});
