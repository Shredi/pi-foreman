// D102: pr_follow and pr_watch {repo, number} resolve a missing host locally (checkout remotes, then the tracked list, then the only configured host) and refuse
// otherwise; every new tracked line carries its host. The ghe checkout is a real temporary git repository with a ghe remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PR_FOLLOW, registerPrFollow, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, TrackOutcome } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import { remoteReposOf } from "../prhost.ts";
import type { GithubHosts } from "../prhost.ts";
import { addTracked, clearStoreCache, readTracked, trackedHostOf } from "../prstore.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const GHE = "ghe.example.test";
const BOTH: GithubHosts = { hosts: ["github.com", GHE] };

type Res = { content: { text: string }[]; details: Record<string, unknown>; isError?: boolean };
type Tool = { name: string; execute: (...a: unknown[]) => Promise<Res> };

function checkout(remote: string): string {
  const dir = fs.realpathSync(mkTestTmp("pf-hostres-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

/** The PR tools over a real tracked list in `agentDir` (addTracked, trackedHostOf). */
function rig(agentDir: string, hosts: GithubHosts) {
  const tools = new Map<string, Tool>();
  const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} }, githubHosts: () => hosts });
  const session: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => null },
    track: async (repo, n, host) => (await addTracked(agentDir, repo, n, undefined, host)) as TrackOutcome,
    trackedHost: (repo, n, hs) => trackedHostOf(agentDir, repo, n, hs),
    githubHosts: () => hosts,
  };
  const reg = { registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never;
  registerPrFollow(reg, { isChild: false, session: async () => session });
  registerPrPack(reg, { isChild: false, session: async () => session, script: "/s.py", spawner: async () => { throw new Error("no host call expected"); }, env: () => ({}), pushRefusal: async () => null } as never);
  const callIn = (cwd: string, name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd });
  const lines = (): Record<string, unknown>[] => {
    const r = readTracked(agentDir);
    return r.kind === "ok" ? (r.lines as Record<string, unknown>[]).map(({ addedAt: _a, ...l }) => l) : [];
  };
  return { callIn, lines, watches };
}

async function withDirs(remote: string | null, fn: (d: { agentDir: string; cwd: string }) => Promise<void>): Promise<void> {
  clearStoreCache();
  const agentDir = mkTestTmp("pf-hostres-agent-");
  const cwd = remote ? checkout(remote) : fs.realpathSync(mkTestTmp("pf-hostres-plain-"));
  try {
    await fn({ agentDir, cwd });
  } finally {
    rmTestTmp(agentDir);
    rmTestTmp(cwd);
  }
}

test("remoteReposOf: scp, https and ssh remotes give host and owner/name; a remote that is not owner/name is skipped", async () => {
  const dir = checkout(`git@${GHE.toUpperCase()}:Acme/App.git`);
  try {
    execFileSync("git", ["remote", "add", "up", "https://github.com/acme/lib.git"], { cwd: dir });
    execFileSync("git", ["remote", "add", "ssh", `ssh://git@host.test:2222/acme/svc.git`], { cwd: dir });
    execFileSync("git", ["remote", "add", "odd", "https://github.com/onlyone"], { cwd: dir });
    const got = (await remoteReposOf(dir)).sort((a, b) => a.host.localeCompare(b.host));
    assert.deepEqual(got, [{ host: GHE, repo: "Acme/App" }, { host: "github.com", repo: "acme/lib" }, { host: "host.test", repo: "acme/svc" }]);
  } finally {
    rmTestTmp(dir);
  }
});

test("pr_follow from a ghe checkout stores the ghe host; a second call without host adds no line", async () => {
  await withDirs(`git@${GHE}:acme/app.git`, async ({ agentDir, cwd }) => {
    const h = rig(agentDir, BOTH);
    const a = await h.callIn(cwd, PR_FOLLOW, { repo: "Acme/App", number: 7 });
    assert.equal(a.isError, undefined, a.content[0].text);
    assert.deepEqual(h.lines(), [{ repo: "Acme/App", number: 7, host: GHE }]);
    const b = await h.callIn(cwd, PR_FOLLOW, { repo: "acme/app", number: 7 });
    assert.match(b.content[0].text, /already following/);
    assert.equal(h.lines().length, 1);
  });
});

test("pr_watch {repo, number} from a ghe checkout stores the ghe host, also when a wrong-host line for the PR already exists", async () => {
  await withDirs(`https://${GHE}/acme/app.git`, async ({ agentDir, cwd }) => {
    await addTracked(agentDir, "acme/app", 7, undefined, "github.com");
    const h = rig(agentDir, BOTH);
    const r = await h.callIn(cwd, "pr_watch", { repo: "acme/app", number: 7 });
    assert.equal(r.details.decision, "watching", r.content[0].text);
    assert.deepEqual(h.watches.list().map((w) => [w.key.host, w.key.repo, w.n]), [[GHE, "acme/app", 7]]);
    assert.deepEqual(h.lines(), [{ repo: "acme/app", number: 7, host: "github.com" }, { repo: "acme/app", number: 7, host: GHE }]);
  });
});

test("no remote match and two hosts: host_unresolved, nothing written, no watch armed", async () => {
  await withDirs("https://github.com/other/thing.git", async ({ agentDir, cwd }) => {
    const h = rig(agentDir, BOTH);
    for (const [tool, p] of [[PR_FOLLOW, { repo: "acme/app", number: 7 }], ["pr_watch", { repo: "acme/app", number: 7 }]] as const) {
      const r = await h.callIn(cwd, tool, { ...p });
      assert.equal(r.isError, true, tool);
      assert.equal(r.details.decision, "host_unresolved", tool);
      assert.match(r.content[0].text, /host not resolved for acme\/app#7: pass host \(one of github\.com, ghe\.example\.test\); nothing was done\.$/);
    }
    assert.deepEqual(h.lines(), []);
    assert.deepEqual(h.watches.list(), []);
  });
});

test("one configured host: it is the host without a remote match; a named host still wins", async () => {
  await withDirs(null, async ({ agentDir, cwd }) => {
    const h = rig(agentDir, { hosts: [GHE] });
    assert.equal((await h.callIn(cwd, PR_FOLLOW, { repo: "acme/app", number: 7 })).isError, undefined);
    assert.deepEqual(h.lines(), [{ repo: "acme/app", number: 7, host: GHE }]);
  });
  await withDirs(null, async ({ agentDir, cwd }) => {
    const h = rig(agentDir, BOTH);
    assert.equal((await h.callIn(cwd, PR_FOLLOW, { repo: "acme/app", number: 7, host: "GitHub.com" })).isError, undefined);
    assert.deepEqual(h.lines(), [{ repo: "acme/app", number: 7, host: "github.com" }]);
  });
});

test("no remote match: the tracked list's host is used; lines on two hosts are host_ambiguous; host-less lines never decide", async () => {
  await withDirs(null, async ({ agentDir, cwd }) => {
    const h = rig(agentDir, BOTH);
    await addTracked(agentDir, "acme/app", 7, undefined, GHE);
    const r = await h.callIn(cwd, PR_FOLLOW, { repo: "acme/app", number: 7 });
    assert.match(r.content[0].text, /already following/);
    assert.equal(h.lines().length, 1);
    await addTracked(agentDir, "acme/app", 7, undefined, "github.com");
    const amb = await h.callIn(cwd, PR_FOLLOW, { repo: "acme/app", number: 7 });
    assert.equal(amb.isError, true);
    assert.equal(amb.details.decision, "host_ambiguous");
    assert.match(amb.content[0].text, /it is tracked on ghe\.example\.test, github\.com; pass host/);
    assert.equal(h.lines().length, 2);
  });
  await withDirs(null, async ({ agentDir, cwd }) => {
    fs.mkdirSync(`${agentDir}/pi-foreman/state`, { recursive: true });
    fs.writeFileSync(`${agentDir}/pi-foreman/state/tracked-prs.json`, JSON.stringify({ v: 1, prs: [{ repo: "acme/app", number: 7, addedAt: 1 }] }));
    assert.deepEqual(trackedHostOf(agentDir, "acme/app", 7, BOTH.hosts), []);
    const r = await rig(agentDir, BOTH).callIn(cwd, PR_FOLLOW, { repo: "acme/app", number: 7 });
    assert.equal(r.details.decision, "host_unresolved");
  });
});

test("addTracked: always writes the host; a host-less github.com line of the same key is upgraded in place", async () => {
  await withDirs(null, async ({ agentDir }) => {
    assert.equal(await addTracked(agentDir, "acme/app", 1, undefined, "GitHub.com"), "added");
    const r = readTracked(agentDir);
    assert.deepEqual(r.kind === "ok" ? r.lines.map((x) => { const { addedAt: _a, ...l } = x as Record<string, unknown>; return l; }) : null, [{ repo: "acme/app", number: 1, host: "github.com" }]);
    fs.writeFileSync(`${agentDir}/pi-foreman/state/tracked-prs.json`, JSON.stringify({ v: 1, prs: [{ repo: "acme/app", number: 2, addedAt: 5 }, { repo: "acme/app", number: 3, addedAt: 6, host: GHE }] }));
    assert.equal(await addTracked(agentDir, "Acme/App", 2, undefined, "github.com"), "present");
    const after = readTracked(agentDir);
    assert.deepEqual(after.kind === "ok" ? after.lines : null, [{ repo: "acme/app", number: 2, addedAt: 5, host: "github.com" }, { repo: "acme/app", number: 3, addedAt: 6, host: GHE }]);
  });
});
