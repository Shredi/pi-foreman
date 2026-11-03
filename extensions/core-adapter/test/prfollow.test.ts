import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PR_FOLLOW, PR_TOOL_NAMES, registerPrFollow, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker, TrackOutcome } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import { isGithubKey } from "../prhost.ts";
import { addTracked, readTracked, trackedFile } from "../prstore.ts";
import type { Spawner } from "../spawn.ts";

type Res = { content: { text: string }[]; details: Record<string, unknown>; isError?: boolean };
type Tool = { name: string; defaultActive?: boolean; execute: (...a: unknown[]) => Promise<Res> };

function rig(o: { track?: (repo: string, n: number) => Promise<TrackOutcome>; isChild?: boolean; packOn?: boolean; url?: string; withTracker?: boolean } = {}) {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const spawned: string[] = [];
  const added: string[] = [];
  const spawner: Spawner = async (_c, _a, i) => {
    const op = JSON.parse(i.input ?? "{}").op as string;
    spawned.push(op);
    if (op === "pr_create") return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: o.url ?? "https://github.com/acme/app/pull/5" }) + "\n", stderr: "", timedOut: false };
    throw new Error(`no gh/pr_ops call expected (${op})`);
  };
  const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) };
  const track = o.track ?? (async (repo: string, n: number) => (added.push(`${repo}#${n}`), "added" as const));
  const session: PrPackSession = { python: "/py", isChild: o.isChild ?? false, packOn: o.packOn ?? true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: (r) => void traces.push(r), tracker: o.withTracker === false ? undefined : tracker, track };
  const reg = { registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never;
  const preflights: string[] = [];
  const preflight = async (_ctx: unknown, op: string) => (preflights.push(op), undefined);
  const followNames = registerPrFollow(reg, { isChild: o.isChild ?? false, session: async () => session });
  registerPrPack(reg, { isChild: o.isChild ?? false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null, preflight } as never);
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: process.cwd() });
  return { tools, call, traces, spawned, added, watches, followNames, session, preflights };
}

test("pr_follow: registered inactive, foreman only, not in the PR pack names", () => {
  const h = rig();
  assert.deepEqual(h.followNames, ["pr_follow"]);
  assert.equal(h.tools.get(PR_FOLLOW)!.defaultActive, false);
  assert.ok(!PR_TOOL_NAMES.includes("pr_follow" as never));
  assert.deepEqual(rig({ isChild: true }).followNames, []);
  assert.equal(rig({ isChild: true }).tools.has("pr_follow"), false);
});

test("pr_follow: added, present and the lost outcomes with their texts and decisions; no preflight, no pr_ops call", async () => {
  const h = rig();
  const a = await h.call("pr_follow", { repo: "acme/app", number: 7 });
  assert.equal(a.details.decision, "ran");
  assert.deepEqual([a.details.tracked, a.details.repo, a.details.number], ["added", "acme/app", 7]);
  assert.match(a.content[0].text, /^pr_follow: following acme\/app#7; herdr-app's `foreman prs poll` polls it and drops it when it is merged or closed$/);
  assert.deepEqual(h.added, ["acme/app#7"]);
  const p = rig({ track: async () => "present" });
  assert.equal((await p.call("pr_follow", { repo: "acme/app", number: 7 })).content[0].text, "pr_follow: already following acme/app#7");
  const f = await rig({ track: async () => "full" }).call("pr_follow", { repo: "acme/app", number: 7 });
  assert.equal(f.details.decision, "tracked_full");
  assert.match(f.content[0].text, /tracked list full \(200 PRs\)/);
  const u = await rig({ track: async () => "unavailable" }).call("pr_follow", { repo: "acme/app", number: 7 });
  assert.equal(u.details.decision, "tracked_unavailable");
  assert.match(u.content[0].text, /could not update the tracked list \(busy, unreadable or not writable\); nothing was done\.$/);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.preflights, []); // pr_follow runs no git and no host program
});

test("pr_follow: bad arguments are refused before track runs; off and a missing track say feed_off", async () => {
  const h = rig();
  const n = await h.call("pr_follow", { repo: "acme/app", number: 0 });
  assert.equal(n.details.decision, "bad_request");
  assert.match(n.content[0].text, /^pr_follow: bad arguments \(number 1\.\.1000000000\); nothing was done\.$/);
  const r = await h.call("pr_follow", { repo: "nope", number: 3 });
  assert.match(r.content[0].text, /^pr_follow: bad arguments \(repo owner\/name\); nothing was done\.$/);
  assert.deepEqual(h.added, []);
  const off = await rig({ track: async () => "off" }).call("pr_follow", { repo: "acme/app", number: 3 });
  assert.equal(off.details.decision, "feed_off");
  assert.match(off.content[0].text, /^pr_follow: the PR feed is off \(radar\.openPrs\.enabled false, or tools\.prHost not auto\/gh\); nothing was done\.$/);
  const h2 = rig();
  (h2.session as { track?: unknown }).track = undefined;
  assert.equal((await h2.call("pr_follow", { repo: "acme/app", number: 3 })).details.decision, "feed_off");
});

test("pr_follow: a child gets the refusal first, also with bad arguments; the pack off refuses", async () => {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const session = { python: "/py", isChild: true, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches: rig().watches, trace: (r: Record<string, unknown>) => void traces.push(r) } as PrPackSession;
  // a child session in a non-child registration (the session says child): the execute-time check
  registerPrFollow({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session });
  const r = await tools.get("pr_follow")!.execute("id", { repo: "bad", number: -1 }, undefined, undefined, { cwd: "/" });
  assert.equal(r.details.decision, "pr_refused");
  assert.match(r.content[0].text, /\[pr_refused:child\]: children may not follow pull requests/);
  assert.deepEqual(traces, [{ event: "pr_refused", reason: "child", toolFamily: "pr_follow" }]);
  const off = await rig({ packOn: false }).call("pr_follow", { repo: "acme/app", number: 1 });
  assert.equal(off.details.decision, "pr_off");
});

test("pr_track stays a retired name", () => {
  const h = rig();
  assert.equal(h.tools.has("pr_track"), false);
});

test("isGithubKey: github.com in any case with a repo; other hosts or an empty repo fail", () => {
  assert.equal(isGithubKey({ host: "github.com", repo: "a/b", n: 1 }), true);
  assert.equal(isGithubKey({ host: "GitHub.com", repo: "a/b", n: 1 }), true);
  assert.equal(isGithubKey({ host: "ghe.example.com", repo: "a/b", n: 1 }), false);
  assert.equal(isGithubKey({ host: "github.com", repo: "", n: 1 }), false);
  assert.equal(isGithubKey({ host: "", repo: "", n: 1 }), false);
});

test("pr_create: adds once from a github.com URL, also when the arm fails; other URLs add nothing; a lost add keeps the text", async () => {
  const h = rig();
  const r = await h.call("pr_create", { title: "t", body: "b" });
  assert.deepEqual(h.added, ["acme/app#5"]);
  assert.equal(r.details.tracked, "added");
  assert.match(r.content[0].text, /pr_watch: armed/);
  const other = rig({ url: "https://ghe.example.com/acme/app/pull/5" });
  const ro = await other.call("pr_create", { title: "t", body: "b" });
  assert.deepEqual(other.added, []);
  assert.equal(ro.details.tracked, undefined);
  assert.match(ro.content[0].text, /pr_watch: not armed \(only github\.com PRs can be watched/);
  for (const out of ["full", "unavailable"] as const) {
    const lost = rig({ track: async () => out });
    const rl = await lost.call("pr_create", { title: "t", body: "b" });
    assert.equal(rl.details.decision, "ran");
    assert.equal(rl.details.tracked, out);
    assert.match(rl.content[0].text, /^pr_create: \{/);
  }
  const bad = rig();
  bad.session.watches.start({ host: "github.com", repo: "acme/app", n: 5 }, { state: "open", mergeable: "mergeable", head: "a", base: "main", updatedAt: "", runs: [] });
  await bad.call("pr_create", { title: "t", body: "b" });
  assert.deepEqual(bad.added, ["acme/app#5"]); // the duplicate arm still tracks, once
});

test("pr_watch: adds once whether it arms or finds a duplicate; non-github.com adds nothing and is refused", async () => {
  const h = rig();
  const a = await h.call("pr_watch", { number: 7 });
  assert.equal(a.details.decision, "watching");
  assert.equal(a.details.tracked, "added");
  const b = await h.call("pr_watch", { number: 7 });
  assert.equal(b.details.decision, "duplicate");
  assert.deepEqual(h.added, ["acme/app#7", "acme/app#7"]);
  const none = rig({ withTracker: false });
  const r = await none.call("pr_watch", { number: 7 });
  assert.equal(r.details.decision, "host_unsupported");
  assert.match(r.content[0].text, /^pr_watch: only github\.com PRs can be watched \(the PR tracker covers github\.com\); nothing was done\.$/);
  assert.deepEqual(none.added, []);
  assert.equal(none.session.watches.size(), 0);
  assert.deepEqual([...h.spawned, ...none.spawned], []);
});

test("without track, pr_create and pr_watch set no details.tracked and write no file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prfollow-"));
  try {
    const h = rig();
    (h.session as { track?: unknown }).track = undefined;
    const c = await h.call("pr_create", { title: "t", body: "b" });
    const w = await h.call("pr_watch", { number: 9 });
    assert.equal(c.details.tracked, undefined);
    assert.equal(w.details.tracked, undefined);
    assert.equal(fs.existsSync(trackedFile(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addTracked: idempotent across case; a list that does not parse is never overwritten", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prfollow-"));
  try {
    assert.equal(await addTracked(dir, "Acme/App", 7), "added");
    assert.equal(await addTracked(dir, "acme/app", 7), "present");
    const r = readTracked(dir);
    assert.ok(r.kind === "ok" && r.lines.length === 1);
    fs.writeFileSync(trackedFile(dir), "{not json");
    assert.equal(await addTracked(dir, "acme/app", 8), "unavailable");
    assert.equal(fs.readFileSync(trackedFile(dir), "utf8"), "{not json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addTracked: full at 200, and a busy lock is unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prfollow-"));
  try {
    fs.mkdirSync(path.dirname(trackedFile(dir)), { recursive: true });
    fs.writeFileSync(trackedFile(dir), JSON.stringify({ v: 1, prs: Array.from({ length: 200 }, (_, i) => ({ repo: "a/b", number: i + 1, addedAt: 1 })) }));
    assert.equal(await addTracked(dir, "a/b", 999), "full");
    assert.equal(await addTracked(dir, "a/b", 5), "present");
    fs.writeFileSync(`${trackedFile(dir)}.lock`, "someone");
    let t = 0;
    assert.equal(await addTracked(dir, "a/b", 1000, () => (t += 1)), "unavailable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
