// tools.prGithubHosts in the tracker path (pi-foreman only ever names github.com and ghe.example.test): the resolver, the store key and
// old entries, the PR tools (pr_follow, pr_watch, pr_create's arm, pr_unwatch), restore, and the open-PR search over several hosts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PR_FOLLOW, registerPrFollow, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker, TrackOutcome } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { WatchSnapshot } from "../prwatch.ts";
import { isTrackedKey, resolveGithubHosts } from "../prhost.ts";
import type { GithubHosts, PrKey } from "../prhost.ts";
import { addTracked, clearStoreCache, readStoreEntry, readTracked, storeKey, trackedFile, trackedStateFile, usableLine } from "../prstore.ts";
import { openPrsConfig, openPrsFile, refreshOpenPrs } from "../openprs.ts";
import type { OpenPr } from "../openprs.ts";
import type { Spawner } from "../spawn.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { tick, world } from "./_r46world.ts";

const GHE = "ghe.example.test";
const HOSTS_UNSET = "no GitHub hosts configured: run `foreman setup` (tools.prGithubHosts)";
const BOTH: GithubHosts = { hosts: ["github.com", GHE] };

// ------------------------------------------------------------------------------------------ resolver and store

test("resolveGithubHosts: unset, empty, over 20, bad names; lowercased and deduplicated", () => {
  assert.deepEqual(resolveGithubHosts({}), { error: HOSTS_UNSET });
  const at = (v: unknown) => resolveGithubHosts({ tools: { prGithubHosts: v } });
  assert.deepEqual(at([]), { error: "tools.prGithubHosts: is empty" });
  assert.deepEqual(at(Array.from({ length: 21 }, (_, i) => `h${i}.example.test`)), { error: "tools.prGithubHosts: has more than 20 hosts" });
  for (const bad of ["-a.example.test", "a-.example.test", "a..example.test", ".a.test", "a.test.", "a b", "a/b", "a.test:", "", "a.test:123456"]) assert.deepEqual(at(["github.com", bad]), { error: `tools.prGithubHosts: ${bad} is not a valid host name` }, bad);
  assert.deepEqual(at([7]), { error: "tools.prGithubHosts: 7 is not a valid host name" });
  assert.deepEqual(at(["GitHub.com", GHE.toUpperCase(), "ghe.example.test", "host.test:8443"]), { hosts: ["github.com", GHE, "host.test:8443"] });
  assert.deepEqual(at(Array.from({ length: 20 }, (_, i) => `h${i}.example.test`)).hasOwnProperty("hosts"), true);
});

test("isTrackedKey: the host is in the list (any case) and the repository is set", () => {
  const k = (host: string, repo = "acme/app"): PrKey => ({ host, repo, n: 7 });
  assert.equal(isTrackedKey(k("GHE.example.test"), [GHE]), true);
  assert.equal(isTrackedKey(k("github.com"), [GHE]), false);
  assert.equal(isTrackedKey(k(GHE, ""), [GHE]), false);
});

test("storeKey: github.com (any case, or no host) is unchanged, another host gets a lowercase prefix", () => {
  assert.equal(storeKey("Acme/App", 7), "acme/app#7");
  assert.equal(storeKey("Acme/App", 7, "GitHub.com"), "acme/app#7");
  assert.equal(storeKey("Acme/App", 7, "GHE.example.test"), `${GHE}/acme/app#7`);
});

test("an old tracked line and state entry without a host read as github.com; a line with a bad host is unusable", async () => {
  clearStoreCache();
  const dir = mkTestTmp("prghe-old-");
  try {
    fs.mkdirSync(path.dirname(trackedFile(dir)), { recursive: true });
    fs.writeFileSync(trackedFile(dir), JSON.stringify({ v: 1, prs: [{ repo: "acme/app", number: 7, addedAt: 5 }, { repo: "acme/app", number: 8, addedAt: 5, host: "bad host" }, { repo: "acme/app", number: 9, addedAt: 5, host: 3 }] }));
    const lines = readTracked(dir);
    assert.equal(lines.kind, "ok");
    const usable = lines.kind === "ok" ? lines.lines.map(usableLine) : [];
    assert.deepEqual(usable, [{ repo: "acme/app", number: 7, addedAt: 5 }, null, null]);
    const snap = { state: "open", mergeable: "mergeable", head: "h", base: "main", updatedAt: "t", runs: [] };
    fs.writeFileSync(trackedStateFile(dir), JSON.stringify({ v: 1, trackedAt: Date.now(), prs: { "acme/app#7": { repo: "acme/app", number: 7, snap, okAt: Date.now(), at: 1 } } }));
    const r = readStoreEntry(dir, { host: "github.com", repo: "acme/app", n: 7 }, Date.now(), true, BOTH);
    assert.equal(r.kind, "entry");
    assert.equal(readStoreEntry(dir, { host: GHE, repo: "acme/app", n: 7 }, Date.now(), true, BOTH).kind, "waiting");
    // an unlisted host is refused with the list; an {error} state reports the error before anything else
    assert.deepEqual(readStoreEntry(dir, { host: GHE, repo: "acme/app", n: 7 }, Date.now(), true, { hosts: ["github.com"] }), { kind: "error", error: "only github.com PRs are tracked" });
    assert.deepEqual(readStoreEntry(dir, { host: "github.com", repo: "acme/app", n: 7 }, Date.now(), true, { error: HOSTS_UNSET }), { kind: "error", error: HOSTS_UNSET });
    assert.deepEqual(readStoreEntry(dir, { host: "github.com", repo: "acme/app", n: 7 }, Date.now(), false, { error: HOSTS_UNSET }), { kind: "down" });
  } finally {
    clearStoreCache();
    rmTestTmp(dir);
  }
});

test("addTracked: the host is written lowercase for a non-github.com host only; the same o/r#n on two hosts are two lines", async () => {
  const dir = mkTestTmp("prghe-add-");
  try {
    assert.equal(await addTracked(dir, "acme/app", 7), "added");
    assert.equal(await addTracked(dir, "acme/app", 7, undefined, "GitHub.com"), "present");
    assert.equal(await addTracked(dir, "acme/app", 7, undefined, GHE.toUpperCase()), "added");
    assert.equal(await addTracked(dir, "acme/app", 7, undefined, GHE), "present");
    const prs = JSON.parse(fs.readFileSync(trackedFile(dir), "utf8")).prs as Record<string, unknown>[];
    assert.deepEqual(prs.map(({ addedAt: _a, ...l }) => l), [{ repo: "acme/app", number: 7 }, { repo: "acme/app", number: 7, host: GHE }]);
  } finally {
    rmTestTmp(dir);
  }
});

// ------------------------------------------------------------------------------------------ the PR tools

type Res = { content: { text: string }[]; details: Record<string, unknown>; isError?: boolean };
type Tool = { name: string; execute: (...a: unknown[]) => Promise<Res> };

function rig(o: { hosts?: GithubHosts; at?: { host: string; repo: string } | null; storeEntry?: (key: PrKey) => ReturnType<NonNullable<ConstructorParameters<typeof PrWatches>[0]["storeEntry"]>> } = {}) {
  const tools = new Map<string, Tool>();
  const spawned: string[] = [];
  const tracked: [string, number, string | undefined][] = [];
  const sent: string[] = [];
  const spawner: Spawner = async (_c, _a, i) => {
    const op = JSON.parse(i.input ?? "{}").op as string;
    spawned.push(op);
    if (op === "pr_create") return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" }) + "\n", stderr: "", timedOut: false };
    throw new Error(`no gh call expected (${op})`);
  };
  const hosts = { current: o.hosts ?? BOTH };
  const watches = new PrWatches({ send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} }, githubHosts: () => hosts.current, ...(o.storeEntry ? { storeEntry: o.storeEntry } : {}) });
  const at = o.at === undefined ? { host: GHE, repo: "acme/app" } : o.at;
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => at };
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {}, tracker, track: async (repo, n, host) => (tracked.push([repo, n, host]), "added" as TrackOutcome), githubHosts: () => hosts.current };
  const reg = { registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never;
  registerPrFollow(reg, { isChild: false, session: async () => session });
  registerPrPack(reg, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null } as never);
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: process.cwd() });
  return { call, spawned, tracked, watches, sent, hosts };
}

test("pr_follow: the host defaults to the first list entry, a listed host is tracked with its host, an unlisted one is refused naming the list", async () => {
  const h = rig({ hosts: { hosts: [GHE, "github.com"] } });
  const a = await h.call(PR_FOLLOW, { repo: "acme/app", number: 7 });
  assert.deepEqual(h.tracked, [["acme/app", 7, GHE]]);
  assert.match(a.content[0].text, new RegExp(`^pr_follow: following ${GHE.replace(/\./g, "\\.")}/acme/app#7;`));
  const b = await h.call(PR_FOLLOW, { repo: "acme/app", number: 8, host: "GitHub.com" });
  assert.deepEqual(h.tracked.at(-1), ["acme/app", 8, "github.com"]);
  assert.match(b.content[0].text, /^pr_follow: following acme\/app#8;/); // github.com reads as before
  const before = h.tracked.length;
  const c = await h.call(PR_FOLLOW, { repo: "acme/app", number: 9, host: "other.example.test" });
  assert.equal(c.isError, true);
  assert.equal(c.details.decision, "host_unsupported");
  assert.match(c.content[0].text, /host other\.example\.test is not one of the hosts of tools\.prGithubHosts \(ghe\.example\.test, github\.com\); nothing was done\.$/);
  assert.equal(h.tracked.length, before);
  assert.equal((await h.call(PR_FOLLOW, { repo: "acme/app", number: 9, host: "bad host" })).details.decision, "bad_request");
});

test("pr_follow and pr_watch with the key unset: the plain notice, nothing tracked, no gh call; an invalid list names the key", async () => {
  for (const [hosts, text] of [[{ error: HOSTS_UNSET }, HOSTS_UNSET], [{ error: "tools.prGithubHosts: is empty" }, "tools.prGithubHosts: is empty"]] as [GithubHosts, string][]) {
    const h = rig({ hosts });
    const f = await h.call(PR_FOLLOW, { repo: "acme/app", number: 7 });
    assert.equal(f.isError, true);
    assert.equal(f.content[0].text, `pr_follow: ${text}; nothing was done.`);
    const w = await h.call("pr_watch", { number: 7 });
    assert.equal(w.isError, true);
    assert.equal(w.content[0].text, `pr_watch: ${text}; nothing was done.`);
    const noNumber = await h.call("pr_watch", {});
    assert.equal(noNumber.content[0].text, `pr_watch: ${text}; nothing was done.`);
    assert.deepEqual(h.tracked, []);
    assert.deepEqual(h.spawned, []);
    assert.equal(h.watches.size(), 0);
  }
});

test("pr_create opens the PR and notes that no watch is armed when the key is unset", async () => {
  const h = rig({ hosts: { error: HOSTS_UNSET } });
  const r = await h.call("pr_create", { title: "t", body: "b" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /"number":5/);
  assert.match(r.content[0].text, /\npr_watch: not armed \(no GitHub hosts configured: run `foreman setup` \(tools\.prGithubHosts\)\)$/);
  assert.deepEqual(h.tracked, []);
  assert.equal(h.watches.size(), 0);
});

test("pr_watch from a checkout on a listed ghe host arms and tracks with the host; an unlisted checkout host and an unlisted PR URL are refused naming the list", async () => {
  const h = rig();
  const ok = await h.call("pr_watch", { number: 7 });
  assert.equal(ok.details.decision, "watching");
  assert.deepEqual(h.tracked, [["acme/app", 7, GHE]]);
  assert.deepEqual(h.watches.list().map((w) => [w.key.host, w.key.repo, w.n]), [[GHE, "acme/app", 7]]);

  const un = rig({ at: { host: "other.example.test", repo: "acme/app" } });
  const r = await un.call("pr_watch", { number: 7 });
  assert.equal(r.isError, true);
  assert.equal(r.details.decision, "host_unsupported");
  assert.equal(r.content[0].text, "pr_watch: only github.com, ghe.example.test PRs can be watched (the PR tracker covers github.com, ghe.example.test); nothing was done.");
  assert.deepEqual(un.tracked, []);

  // the URL a status gave wins over the checkout: here an unlisted host
  const only = rig({ hosts: { hosts: ["github.com"] } });
  const r2 = await only.call("pr_watch", { number: 7 });
  assert.equal(r2.content[0].text, "pr_watch: only github.com PRs can be watched (the PR tracker covers github.com); nothing was done.");
});

test("pr_unwatch {number, repo, host} ends only that host's watch; a host outside the list is refused; the key unset still ends a watch", async () => {
  const h = rig();
  const snap: WatchSnapshot = { state: "open", mergeable: "mergeable", head: "h", base: "main", updatedAt: "t", runs: [] };
  h.watches.start({ host: "github.com", repo: "acme/app", n: 7 }, snap);
  h.watches.start({ host: GHE, repo: "acme/app", n: 7 }, snap);
  assert.equal(h.watches.size(), 2);
  const bad = await h.call("pr_unwatch", { number: 7, repo: "acme/app", host: "other.example.test" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not one of the hosts of tools\.prGithubHosts \(github\.com, ghe\.example\.test\)/);
  assert.equal(h.watches.size(), 2);
  const r = await h.call("pr_unwatch", { number: 7, repo: "acme/app", host: GHE.toUpperCase() });
  assert.match(r.content[0].text, /"unwatched":true/);
  assert.deepEqual(h.watches.list().map((w) => w.key.host), ["github.com"]);
  h.hosts.current = { error: HOSTS_UNSET };
  const e = await h.call("pr_unwatch", { number: 7, repo: "acme/app", host: "github.com" });
  assert.match(e.content[0].text, /"unwatched":true/);
  assert.equal(h.watches.size(), 0);
});

// ------------------------------------------------------------------------------------------ restore

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function restorer(dir: string, hosts: GithubHosts) {
  const sent: string[] = [];
  const retracked: PrKey[] = [];
  const w = new PrWatches({ storeEntry: (key) => readStoreEntry(dir, key, Date.now(), true, hosts), githubHosts: () => hosts, retrack: (k) => void retracked.push(k), send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => Date.now(), timers: { set: () => 1, clear: () => {} } });
  return { w, sent, retracked };
}

function records(keys: PrKey[]) {
  const src = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  for (const k of keys) src.startPending(k);
  return src.records();
}

test("restore: a listed ghe watch stays, an unlisted one ends with the list-named text, a number-only key ends in every state", async () => {
  const dir = mkTestTmp("prghe-restore-");
  try {
    const recs = records([{ host: GHE, repo: "acme/app", n: 1 }, { host: "other.example.test", repo: "acme/app", n: 2 }, { host: "", repo: "", n: 3 }]);
    const a = restorer(dir, BOTH);
    a.w.restore({ status: "ok", watches: recs, bad: 0 });
    await flush();
    assert.deepEqual(a.w.list().map((w) => w.n), [1]);
    const lostMsgs = a.sent.filter((m) => m.includes("watch lost on restart"));
    assert.equal(lostMsgs.length, 2);
    assert.match(lostMsgs[0], /the PR tracker covers github\.com, ghe\.example\.test only; this watch from an earlier version ended\. Re-arm it with pr_watch\./);
    assert.deepEqual(a.retracked.map((k) => k.n), [1]); // the retrack hook gets the key with its host
    assert.equal(a.retracked[0].host, GHE);
    const b = restorer(dir, { error: HOSTS_UNSET });
    b.w.restore({ status: "ok", watches: recs, bad: 0 });
    await flush();
    assert.deepEqual(b.w.list().map((w) => w.n).sort(), [1, 2]); // kept armed; only the number-only key is lost
  } finally {
    rmTestTmp(dir);
  }
});

test("restore with the key unset: the watch stays armed, its status and one notice show the text (not lost, not the tracker-down line); pr_unwatch ends it", async () => {
  const dir = mkTestTmp("prghe-restore-unset-");
  try {
    const h = restorer(dir, { error: HOSTS_UNSET });
    h.w.restore({ status: "ok", watches: records([{ host: "github.com", repo: "acme/app", n: 7 }]), bad: 0 });
    await flush();
    assert.equal(h.w.size(), 1);
    assert.equal(h.w.list()[0].event, HOSTS_UNSET);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0], /no GitHub hosts configured: run `foreman setup` \(tools\.prGithubHosts\) \(the watch stays armed\)/);
    assert.doesNotMatch(h.sent[0], /lost on restart|no PR tracker running/);
    assert.equal(h.w.unwatch(7, "acme/app"), 1);
    assert.equal(h.w.size(), 0);
  } finally {
    rmTestTmp(dir);
  }
});

// ------------------------------------------------------------------------------------------ the open-PR search

const node = (host: string, n: number) => ({ number: n, title: `T${n}`, url: `https://${host}/acme/lib/pull/${n}`, repository: { nameWithOwner: "acme/lib" } });
const answer = (...nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });
const hostOf = (args: string[]): string => (args.includes("--hostname") ? args[args.indexOf("--hostname") + 1] : "github.com");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as { openPrs: OpenPr[]; error?: string; fetchedAt?: string };

test("open-PR search over two hosts: github.com keeps its argv, ghe adds --hostname, entries carry host only for ghe", async () => {
  const dir = mkTestTmp("prghe-search-");
  try {
    const file = openPrsFile(dir);
    const argvs: string[][] = [];
    const gh = async (args: string[]) => (argvs.push(args), answer(node(hostOf(args), 7)));
    assert.equal(await refreshOpenPrs({ file, config: openPrsConfig({ enabled: true, mine: true }), gh, hosts: BOTH, force: true }), "refreshed");
    const plain = argvs.filter((a) => !a.includes("--hostname"));
    assert.ok(plain.length > 0 && plain.every((a) => a[0] === "api" && a[1] === "graphql" && a[2] === "-f"));
    assert.ok(argvs.some((a) => a.slice(0, 4).join(" ") === `api graphql --hostname ${GHE}`));
    assert.deepEqual(read(file).openPrs.map((p) => [p.url, p.host]), [["https://github.com/acme/lib/pull/7", undefined], [`https://${GHE}/acme/lib/pull/7`, GHE]]);
    assert.equal("host" in read(file).openPrs[0], false);
  } finally {
    rmTestTmp(dir);
  }
});

test("open-PR search: a failing host keeps its previous entries and does not hide the other host's results (both ways)", async () => {
  const dir = mkTestTmp("prghe-search-fail-");
  try {
    const file = openPrsFile(dir);
    const config = openPrsConfig({ enabled: true, mine: true });
    for (const failing of [GHE, "github.com"]) {
      await refreshOpenPrs({ file, config, gh: async (a) => answer(node(hostOf(a), 7)), hosts: BOTH, force: true });
      const other = failing === GHE ? "github.com" : GHE;
      const gh = async (a: string[]) => {
        if (hostOf(a) === failing) throw new Error("boom");
        return answer(node(hostOf(a), 8));
      };
      assert.equal(await refreshOpenPrs({ file, config, gh, hosts: BOTH, force: true }), "refreshed");
      const d = read(file);
      assert.match(d.error ?? "", /^2 of 4 queries failed: .*boom/);
      assert.ok(d.openPrs.some((p) => p.url === `https://${failing}/acme/lib/pull/7`), `${failing}'s previous entry stays`);
      assert.ok(d.openPrs.some((p) => p.url === `https://${other}/acme/lib/pull/8`), `${other}'s new entry shows`);
      assert.ok(!d.openPrs.some((p) => p.url === `https://${other}/acme/lib/pull/7`), `${other}'s old entry is replaced`);
    }
    // every query failed: the old way, everything kept
    const before = read(file).openPrs;
    assert.equal(await refreshOpenPrs({ file, config, gh: async () => { throw new Error("down"); }, hosts: BOTH, force: true }), "failed");
    assert.deepEqual(read(file).openPrs, before);
  } finally {
    rmTestTmp(dir);
  }
});

test("open-PR search: the query budget stays at 20 across hosts and every host gets at least one query", async () => {
  const dir = mkTestTmp("prghe-search-budget-");
  try {
    const hosts: GithubHosts = { hosts: ["github.com", GHE, "ghe2.example.test"] };
    const config = openPrsConfig({ enabled: true, mine: true, authors: Array.from({ length: 6 }, (_, i) => `bot${i}[bot]`), scope: ["acme", "beta", "gamma"] });
    const seen: string[] = [];
    await refreshOpenPrs({ file: openPrsFile(dir), config, gh: async (a) => (seen.push(hostOf(a)), answer()), hosts, force: true });
    assert.equal(seen.length, 20);
    for (const h of hosts.hosts) assert.ok(seen.filter((x) => x === h).length >= 1, h);
    const one: string[] = [];
    await refreshOpenPrs({ file: openPrsFile(dir), config: openPrsConfig({ enabled: true, mine: false, authors: ["a"], scope: ["acme"] }), gh: async (a) => (one.push(hostOf(a)), answer()), hosts, force: true });
    assert.deepEqual(one.sort(), ["ghe.example.test", "ghe2.example.test", "github.com"].sort());
  } finally {
    rmTestTmp(dir);
  }
});

test("open-PR search with the key unset or invalid: no gh call, the error is recorded, the previous entries stay; an off feed stays off", async () => {
  const dir = mkTestTmp("prghe-search-error-");
  try {
    const file = openPrsFile(dir);
    const config = openPrsConfig({ enabled: true, mine: true });
    await refreshOpenPrs({ file, config, gh: async (a) => answer(node(hostOf(a), 7)), hosts: BOTH, force: true });
    let calls = 0;
    const gh = async () => (calls++, answer());
    assert.equal(await refreshOpenPrs({ file, config, gh, hosts: { error: HOSTS_UNSET }, force: true }), "failed");
    assert.equal(calls, 0);
    const d = read(file);
    assert.equal(d.error, HOSTS_UNSET);
    assert.equal(d.openPrs.length, 2);
    assert.ok(d.fetchedAt);
    const off = mkTestTmp("prghe-search-off-");
    try {
      assert.equal(await refreshOpenPrs({ file: openPrsFile(off), config: openPrsConfig({ enabled: false }), gh, hosts: { error: HOSTS_UNSET }, force: true }), "off");
      assert.equal(fs.existsSync(openPrsFile(off)), false);
    } finally {
      rmTestTmp(off);
    }
  } finally {
    rmTestTmp(dir);
  }
});

// ------------------------------------------------------------------------------------------ the adapter

const LOG = process.env.FOREMAN_FAKE_GH_LOG;
const skip = LOG ? false : "the fake gh is set by _hermetic-env.mjs (test:node) and not on Windows";
const calls = (): string[] => fs.readFileSync(LOG!, "utf8").split("\n").filter(Boolean);

test("the in-pi refresher of an adapter session with a ghe-only list searches with --hostname", { skip }, async (t) => {
  const w = world(t);
  const agentDir = path.resolve(w.handoff, "..", "..", "..");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ radar: { openPrs: { enabled: true } }, tools: { prGithubHosts: [GHE] } }));
  const before = calls().length;
  await w.adapter();
  for (let i = 0; i < 80 && !calls().slice(before).some((c) => c.startsWith(`api graphql --hostname ${GHE} `)); i++) await tick(100);
  assert.ok(calls().slice(before).some((c) => c.startsWith(`api graphql --hostname ${GHE} `)), "the search names the ghe host");
});
