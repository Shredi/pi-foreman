import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, readStoreEntry, storeKey, trackedCommentsFile, trackedFile, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;

type Row = Record<string, unknown>;
const row = (repo: string, n: number, o: Row = {}): Row => ({ repo, number: n, state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1", url: `https://github.com/${repo}/pull/${n}`, title: `t${n}`, draft: false, headRefName: "feat", headRepo: repo, runs: [{ id: "1", name: "ci", bucket: "passed", url: "x" }], ...o });

interface World {
  rows: Map<string, Row | "gone" | "error">;
  calls: { op: string; args: Record<string, unknown> }[];
  searched: number;
  clock: { t: number };
}

function setup(over: { config?: Record<string, unknown>; safetyFallback?: boolean; deadlineMs?: number; tick?: number } = {}) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prspoll-"));
  const w: World = { rows: new Map(), calls: [], searched: 0, clock: { t: T0 } };
  const pythons: string[] = [];
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => (w.clock.t += over.tick ?? 0),
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: over.config ?? {}, warnings: [], errors: ["bad"], safetyFallback: over.safetyFallback ?? false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: (python) => async (op, args) => {
      pythons.push(python);
      w.calls.push({ op, args });
      if (op === "pr_batch") {
        const prs: Row[] = [];
        const errors: Row[] = [];
        for (const p of args.prs as { repo: string; n: number }[]) {
          const r = w.rows.get(storeKey(p.repo, p.n));
          if (r === "gone") errors.push({ repo: p.repo, number: p.n, kind: "pr_not_found" });
          else if (r === "error" || !r) errors.push({ repo: p.repo, number: p.n, kind: "host_error" });
          else prs.push(r);
        }
        return { kind: "ran", result: { prs, errors } } as SafeOpOutcome;
      }
      return { kind: "ran", result: { comments: [{ id: "c1", kind: "issue", author: "bob", body: "x".repeat(900) }] } } as SafeOpOutcome;
    },
    refresh: async () => {
      w.searched += 1;
      return "refreshed";
    },
    ...(over.deadlineMs !== undefined ? { deadlineMs: over.deadlineMs } : {}),
  };
  return { deps, w, agentDir, pythons };
}

const state = (dir: string) => JSON.parse(fs.readFileSync(trackedStateFile(dir), "utf8"));
const list = (dir: string) => JSON.parse(fs.readFileSync(trackedFile(dir), "utf8")).prs as { repo: string; number: number }[];

test("open PR is kept with okAt, meta and comments (capped); the list keeps it", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  const r = await pollPrs(h.deps);
  assert.deepEqual({ tracked: r.tracked, dropped: r.dropped, searched: r.searched }, { tracked: 1, dropped: 0, searched: true });
  const e = state(h.agentDir).prs["acme/app#1"];
  assert.equal(e.snap.state, "open");
  assert.equal(e.okAt >= T0, true);
  assert.deepEqual(e.meta, { url: "https://github.com/acme/app/pull/1", title: "t1", draft: false, headRefName: "feat", headRepo: "acme/app" });
  assert.equal("comments" in e.snap, false);
  const c = JSON.parse(fs.readFileSync(trackedCommentsFile(h.agentDir), "utf8")).prs["acme/app#1"];
  assert.equal(c.updatedAt, "u1");
  assert.equal(c.comments[0].body.length, 500);
  assert.equal(list(h.agentDir).length, 1);
});

test("merged and closed are written with endedAt, dropped from the list, and the comments are removed", async () => {
  const h = setup();
  for (const n of [1, 2, 3]) await addTracked(h.agentDir, "acme/app", n, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1, { state: "merged" }));
  h.w.rows.set("acme/app#2", row("acme/app", 2, { state: "closed" }));
  h.w.rows.set("acme/app#3", row("acme/app", 3));
  const r = await pollPrs(h.deps);
  assert.equal(r.dropped, 2);
  assert.deepEqual(list(h.agentDir).map((l) => l.number), [3]);
  const st = state(h.agentDir);
  assert.equal(st.prs["acme/app#1"].snap.state, "merged");
  assert.equal(typeof st.prs["acme/app#1"].endedAt, "number");
  assert.equal(st.prs["acme/app#2"].snap.state, "closed");
  const c = JSON.parse(fs.readFileSync(trackedCommentsFile(h.agentDir), "utf8")).prs;
  assert.deepEqual(Object.keys(c), ["acme/app#3"]);
  // the session still sees the ending
  const read = readStoreEntry(h.agentDir, { host: "github.com", repo: "acme/app", n: 1 }, h.w.clock.t, true);
  assert.equal(read.kind === "entry" && read.snap.state, "merged");
});

test("an ended entry is kept for 15 minutes, then pruned", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1, { state: "merged" }));
  await pollPrs(h.deps);
  h.w.clock.t += 60_000;
  await pollPrs(h.deps);
  assert.ok(state(h.agentDir).prs["acme/app#1"]);
  h.w.clock.t += 15 * 60_000;
  await pollPrs(h.deps);
  assert.equal(state(h.agentDir).prs["acme/app#1"], undefined);
});

test("gone and error keep the entry and its okAt and set errorAt; a later open snap clears them", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  await addTracked(h.agentDir, "acme/app", 2, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  h.w.rows.set("acme/app#2", row("acme/app", 2));
  await pollPrs(h.deps);
  const okAt = state(h.agentDir).prs["acme/app#1"].okAt;
  h.w.clock.t += 60_000;
  h.w.rows.set("acme/app#1", "gone");
  h.w.rows.set("acme/app#2", "error");
  await pollPrs(h.deps);
  const st = state(h.agentDir);
  assert.equal(st.prs["acme/app#1"].okAt, okAt);
  assert.equal(st.prs["acme/app#1"].gone, true);
  assert.equal(typeof st.prs["acme/app#1"].errorAt, "number");
  assert.equal(typeof st.prs["acme/app#2"].error, "string");
  assert.equal(list(h.agentDir).length, 2);
  h.w.clock.t += 60_000;
  h.w.rows.set("acme/app#1", row("acme/app", 1, { updatedAt: "u2" }));
  await pollPrs(h.deps);
  const e = state(h.agentDir).prs["acme/app#1"];
  assert.equal(e.error, undefined);
  assert.equal(e.errorAt, undefined);
  assert.equal(e.gone, undefined);
});

test("the RunOp is called with the python of the run; pr_comments gets repo and host", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  assert.deepEqual(new Set(h.pythons), new Set(["/py"]));
  const c = h.w.calls.find((x) => x.op === "pr_comments");
  assert.equal(c?.args.repo, "acme/app");
  assert.equal(c?.args.host, "github.com");
  assert.equal(h.w.calls.find((x) => x.op === "pr_batch")?.args.watch, true);
});

test("not due: nothing to poll within 25 s makes no RunOp call but still searches; an addedAt newer than trackedAt is due", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  const before = h.w.calls.length;
  h.w.clock.t += 10_000;
  const r = await pollPrs(h.deps);
  assert.equal(r.skipped, "not_due");
  assert.equal(r.searched, true);
  assert.equal(h.w.calls.length, before);
  await addTracked(h.agentDir, "acme/app", 2, () => h.w.clock.t);
  h.w.rows.set("acme/app#2", row("acme/app", 2));
  h.w.clock.t += 1000;
  const r2 = await pollPrs(h.deps);
  assert.equal(r2.skipped, undefined);
  assert.equal(r2.tracked >= 1, true);
});

test("a hand-removed line is pruned from the state; invalid lines are skipped", async () => {
  const h = setup();
  fs.mkdirSync(path.dirname(trackedFile(h.agentDir)), { recursive: true });
  fs.writeFileSync(trackedFile(h.agentDir), JSON.stringify({ v: 1, prs: [{ repo: "acme/app", number: 1, addedAt: 1 }, { repo: "bad", number: 2 }, 7, { repo: "acme/app", number: 0 }] }));
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  const r = await pollPrs(h.deps);
  assert.equal(r.tracked, 1);
  fs.writeFileSync(trackedFile(h.agentDir), JSON.stringify({ v: 1, prs: [] }));
  h.w.clock.t += 60_000;
  await pollPrs(h.deps);
  assert.deepEqual(Object.keys(state(h.agentDir).prs), []);
});

test("an unparseable list is left alone and reports list_unreadable", async () => {
  const h = setup();
  fs.mkdirSync(path.dirname(trackedFile(h.agentDir)), { recursive: true });
  fs.writeFileSync(trackedFile(h.agentDir), "nope");
  const r = await pollPrs(h.deps);
  assert.equal(r.skipped, "list_unreadable");
  assert.equal(fs.readFileSync(trackedFile(h.agentDir), "utf8"), "nope");
  assert.equal(h.w.calls.length, 0);
});

test("a busy state lock skips the tracked step (busy) and the search still runs", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  fs.mkdirSync(path.dirname(trackedStateFile(h.agentDir)), { recursive: true });
  fs.writeFileSync(`${trackedStateFile(h.agentDir)}.lock`, "other");
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  const r = await pollPrs(h.deps);
  assert.equal(r.skipped, "busy");
  assert.equal(r.searched, true);
  assert.equal(h.w.calls.length, 0);
});

test("off: enabled false or a template host sets the off flag, makes no call and no search; a later good run clears it", async () => {
  for (const config of [{ radar: { openPrs: { enabled: false } } }, { tools: { prHost: "template" } }]) {
    const h = setup({ config });
    await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
    const r = await pollPrs(h.deps);
    assert.equal(r.skipped, "off");
    assert.equal(r.searched, false);
    assert.equal(h.w.calls.length, 0);
    assert.equal(h.w.searched, 0);
    assert.equal(state(h.agentDir).off, true);
    const deps2: PollDeps = { ...h.deps, loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig };
    h.w.rows.set("acme/app#1", row("acme/app", 1));
    await pollPrs(deps2);
    assert.equal(state(h.agentDir).off, undefined);
  }
});

test("off with a busy state lock writes nothing", async () => {
  const h = setup({ config: { radar: { openPrs: { enabled: false } } } });
  fs.mkdirSync(path.dirname(trackedStateFile(h.agentDir)), { recursive: true });
  fs.writeFileSync(`${trackedStateFile(h.agentDir)}.lock`, "other");
  const r = await pollPrs(h.deps);
  assert.equal(r.skipped, "off");
  assert.equal(fs.existsSync(trackedStateFile(h.agentDir)), false);
});

test("a config with safetyFallback skips both steps and reports an error", async () => {
  const h = setup({ safetyFallback: true });
  const r = await pollPrs(h.deps);
  assert.match(r.error ?? "", /config load failed/);
  assert.equal(h.w.searched, 0);
  assert.equal(h.w.calls.length, 0);
});

test("the deadline stops ops and the item keeps its entry and its turn", async () => {
  const h = setup({ deadlineMs: -1 });
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  assert.equal(h.w.calls.length, 0);
  assert.equal(state(h.agentDir).prs["acme/app#1"], undefined);
  assert.equal(list(h.agentDir).length, 1);
});

test("at most 50 PRs per run, fresh adds first, then the oldest", async () => {
  const h = setup();
  for (let n = 1; n <= 55; n++) {
    await addTracked(h.agentDir, "acme/app", n, () => T0 - 1000);
    h.w.rows.set(`acme/app#${n}`, row("acme/app", n));
  }
  const r = await pollPrs(h.deps);
  assert.equal(r.tracked, 50);
  h.w.clock.t += 60_000;
  const r2 = await pollPrs(h.deps);
  assert.equal(r2.tracked, 50);
  const nums = Object.values(state(h.agentDir).prs as Record<string, { number: number }>).map((e) => e.number);
  assert.equal(nums.length, 55);
});

test("the state lock is dropped before the search runs; a thrown search ends in error with the tracked result", async () => {
  const h = setup();
  let lockAtSearch: boolean | null = null;
  h.deps.refresh = async () => {
    lockAtSearch = fs.existsSync(`${trackedStateFile(h.agentDir)}.lock`);
    throw new Error("boom");
  };
  const r = await pollPrs(h.deps);
  assert.equal(lockAtSearch, false);
  assert.equal(r.error, "boom");
});

test("a Python miss reports the resolver's hint in error and still searches", async () => {
  const h = setup();
  h.deps.resolve = async () => ({ ok: false, rejected: ["nothing here"] });
  const r = await pollPrs(h.deps);
  assert.match(r.error ?? "", /no Python >= 3\.13 found \(nothing here\)/);
  assert.equal(r.searched, true);
});

test("an overlay python.path that differs from the hint is the Python of every RunOp", async () => {
  const h = setup({ config: { python: { path: "/overlay/py" } } });
  h.deps.resolve = async (p) => ({ ok: true, info: { executable: p ?? "/hint-less", version: [3, 13], source: "t" }, rejected: [] });
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.w.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  assert.ok(h.pythons.length > 0);
  assert.deepEqual(new Set(h.pythons), new Set(["/overlay/py"]));
});

test("a thrown fault never escapes", async () => {
  const h = setup();
  h.deps.loadConfig = async () => {
    throw new Error("load boom");
  };
  const r = await pollPrs(h.deps);
  assert.equal(r.error, "load boom");
});

test("main: --json shape, the plain line, and usage errors exit 2", async () => {
  const h = setup();
  let out = "";
  let err = "";
  assert.equal(await main(["poll", "--json"], (s) => (out += s), (s) => (err += s), () => h.deps), 0);
  assert.deepEqual(JSON.parse(out), { tracked: 0, dropped: 0, searched: true });
  out = "";
  assert.equal(await main(["poll"], (s) => (out += s), (s) => (err += s), () => h.deps), 0);
  assert.match(out, /^prs poll: tracked 0, dropped 0, searched yes, skipped not_due\n$/);
  for (const argv of [[], ["other"], ["poll", "--jsn"]]) {
    err = "";
    assert.equal(await main(argv, () => {}, (s) => (err += s), () => h.deps), 2);
    assert.match(err, /^usage: foreman prs poll \[--json\]/);
  }
});
