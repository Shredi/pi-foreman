import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrBot, parseLease, parseSnapshot, realFs, sharedConfig, sharedDoctorLines, EMPTY_GRACE_MS, MAX_BACKOFF_MS } from "../prbot.ts";
import type { PrBotDeps, PrBotFs } from "../prbot.ts";
import type { PrOp } from "../gitpack.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { Timers } from "../prwatch.ts";

const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result: { ok: true, ...result } });
const pre = (precondition: string): SafeOpOutcome => ({ kind: "precondition", precondition, message: "m" });
const hostFail = (message: string): SafeOpOutcome => ({ kind: "error", message });
const url = (repo: string, n: number, host = "github.com") => `https://${host}/${repo}/pull/${n}`;
const poll = (status: number, extra: Record<string, unknown> = {}) => ran({ action: "pr_poll", status, lastModified: null, etag: null, pollInterval: null, items: status === 200 ? [] : null, ...extra });
const T0 = 1_800_000_000_000;
const CFG = { enabled: true, authors: ["ci-bot"], seconds: 60, events: true };

/** One shared in-memory file system with a clock; every write is recorded. */
class MemFs implements PrBotFs {
  files = new Map<string, { text: string; mtimeMs: number }>();
  writes: { path: string; text: string }[] = [];
  exclusiveFails = 0;
  reads = 0;
  clock: () => number;
  constructor(clock: () => number) {
    this.clock = clock;
  }
  createExclusive(p: string, data: string): boolean {
    if (this.files.has(p)) {
      this.exclusiveFails += 1;
      return false;
    }
    this.files.set(p, { text: data, mtimeMs: this.clock() });
    this.writes.push({ path: p, text: data });
    return true;
  }
  read(p: string): string | null {
    this.reads += 1;
    return this.files.get(p)?.text ?? null;
  }
  stat(p: string) {
    const f = this.files.get(p);
    return f ? { mtimeMs: f.mtimeMs, size: Buffer.byteLength(f.text) } : null;
  }
  writeAtomic(p: string, data: string): void {
    this.files.set(p, { text: data, mtimeMs: this.clock() });
    this.writes.push({ path: p, text: data });
  }
  remove(p: string): void {
    this.files.delete(p);
  }
  put(p: string, text: string, mtimeMs = this.clock()): void {
    this.files.set(p, { text, mtimeMs });
  }
}

/** A scheduler with a manual clock, shared by every bot of a test. */
function world() {
  let now = T0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let seq = 0;
  const fake: Timers = {
    set: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clear: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.fn();
      await settle();
    }
    now = end;
    await settle();
  };
  const memfs = new MemFs(() => now);
  return { fake, advance, settle, clock: () => now, memfs, pending: () => timers.length };
}
type World = ReturnType<typeof world>;

type Handler = (args: Record<string, unknown>) => SafeOpOutcome | Promise<SafeOpOutcome>;
interface Call {
  op: PrOp;
  args: Record<string, unknown>;
  cwd: string;
  at: number;
}

function bot(w: World, id: string, o: { cfg?: unknown; random?: number; host?: string; pid?: number; kill?: (pid: number) => void; active?: boolean; prHost?: unknown; handlers?: Partial<Record<PrOp, Handler>>; fs?: PrBotFs; dir?: string } = {}) {
  const calls: Call[] = [];
  const traces: Record<string, unknown>[] = [];
  const handlers: Partial<Record<PrOp, Handler>> = {
    pr_poll: (a) => poll(200),
    pr_search: () => ran({ action: "pr_search", prs: [] }),
    pr_batch: () => ran({ action: "pr_batch", prs: [], errors: [] }),
    pr_login: () => ran({ action: "pr_login", login: "me-user" }),
    ...o.handlers,
  };
  let cfg: unknown = o.cfg ?? CFG;
  const deps: PrBotDeps = {
    active: () => o.active ?? true,
    config: () => cfg,
    prHost: () => o.prHost ?? "auto",
    dir: o.dir ?? "/agent/pi-foreman/state/prbot",
    sessionId: id,
    run: async (op, args, cwd) => {
      calls.push({ op, args, cwd, at: w.clock() });
      const h = handlers[op];
      return h ? h(args) : pre("pr_unsupported");
    },
    cwd: () => "/work/leader",
    trace: (r) => void traces.push(r),
    timers: w.fake,
    now: w.clock,
    random: () => o.random ?? 0,
    fs: o.fs ?? w.memfs,
    pid: o.pid ?? 4242,
    hostname: o.host ?? "host-a",
    kill: o.kill ?? (() => undefined),
  };
  const b = new PrBot(deps);
  return {
    b,
    calls,
    traces,
    setCfg: (c: unknown) => void (cfg = c),
    outcomes: (outcome: string) => traces.filter((t) => t.outcome === outcome),
    ops: (op: PrOp) => calls.filter((c) => c.op === op),
  };
}

const LEASE = "/agent/pi-foreman/state/prbot/lease.json";
const SNAP = "/agent/pi-foreman/state/prbot/snapshot.json";
const lease = (w: World): Record<string, unknown> => JSON.parse(w.memfs.files.get(LEASE)?.text ?? "{}");
const snap = (w: World): Record<string, any> => JSON.parse(w.memfs.files.get(SNAP)?.text ?? "{}");
const leaseOf = (sessionId: string, w: World, o: Record<string, unknown> = {}) => JSON.stringify({ sessionId, pid: 99, hostname: "host-a", acquiredAt: w.clock(), renewedAt: w.clock(), expiresAt: w.clock() + 300_000, ...o });

// ------------------------------------------------------------------ config

test("prbot_config_defaults_and_bounds", () => {
  assert.deepEqual(sharedConfig(undefined), { enabled: false, authors: [], seconds: 180, events: true });
  assert.equal(sharedConfig({ enabled: true, seconds: 5 }).seconds, 60);
  assert.equal(sharedConfig({ enabled: true, seconds: 99999 }).seconds, 3600);
  assert.equal(sharedConfig({ authors: Array.from({ length: 12 }, (_, i) => `bot${i}`) }).authors.length, 8);
  assert.equal(sharedConfig({ events: false }).events, false);
});

// ------------------------------------------------------------------ lease

test("prbot_exclusive_create_with_two_sessions_gives_one_leader", async () => {
  const w = world();
  const a = bot(w, "sess-a");
  // B looked before A created the file: its exclusive create loses with EEXIST.
  let blind = true;
  const m = w.memfs;
  const staleView: PrBotFs = {
    createExclusive: (p, d) => m.createExclusive(p, d),
    read: (p) => m.read(p),
    stat: (p) => (blind && p === LEASE ? ((blind = false), null) : m.stat(p)),
    writeAtomic: (p, d) => m.writeAtomic(p, d),
    remove: (p) => m.remove(p),
  };
  const b = bot(w, "sess-b", { fs: staleView });
  a.b.start();
  b.b.start();
  await w.advance(0);
  assert.equal(w.memfs.exclusiveFails, 1);
  assert.equal(lease(w).sessionId, "sess-a");
  assert.equal(a.outcomes("lease_acquired").length, 1);
  assert.equal(b.outcomes("lease_acquired").length, 0);
  assert.match(a.b.describe(), /\(leader;/);
  assert.match(b.b.describe(), /\(follower;/);
  a.b.dispose();
  b.b.dispose();
});

test("prbot_empty_lease_file_is_stale_only_after_the_grace", async () => {
  const w = world();
  w.memfs.put(LEASE, "");
  const b = bot(w, "sess-b");
  b.b.start();
  await w.advance(0);
  assert.equal(w.memfs.files.get(LEASE)?.text, "", "within the grace the empty file is respected");
  await w.advance(EMPTY_GRACE_MS + 1_000);
  // the follower re-reads every `seconds` (60 s): it takes over then
  await w.advance(60_000);
  assert.equal(lease(w).sessionId, "sess-b");
  assert.equal(b.outcomes("lease_acquired").length, 1);
  b.b.dispose();
});

test("prbot_unparseable_lease_file_follows_the_same_grace", async () => {
  const w = world();
  w.memfs.put(LEASE, "{not json");
  const b = bot(w, "sess-b");
  b.b.start();
  await w.advance(0);
  assert.equal(w.memfs.files.get(LEASE)?.text, "{not json");
  await w.advance(70_000);
  assert.equal(lease(w).sessionId, "sess-b");
  b.b.dispose();
});

test("prbot_two_sessions_racing_a_stale_takeover_give_one_leader_with_different_jitter", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("dead-session", w, { expiresAt: w.clock() - 1 }));
  const a = bot(w, "sess-a", { random: 0.2 });
  const b = bot(w, "sess-b", { random: 0.6 });
  a.b.start();
  b.b.start();
  await w.advance(10_000);
  assert.equal(lease(w).sessionId, "sess-a");
  assert.match(a.b.describe(), /\(leader;/);
  assert.match(b.b.describe(), /\(follower;/);
  assert.equal(b.outcomes("lease_acquired").length, 0);
  a.b.dispose();
  b.b.dispose();
});

test("prbot_two_sessions_racing_with_equal_jitter_keep_only_the_last_writer", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("dead-session", w, { expiresAt: w.clock() - 1 }));
  const a = bot(w, "sess-a", { random: 0.4 });
  const b = bot(w, "sess-b", { random: 0.4 });
  a.b.start();
  b.b.start();
  await w.advance(10_000);
  const leaders = [a, b].filter((x) => /\(leader;/.test(x.b.describe()));
  assert.equal(leaders.length, 1);
  assert.equal(lease(w).sessionId, leaders[0] === a ? "sess-a" : "sess-b");
  a.b.dispose();
  b.b.dispose();
});

test("prbot_stale_by_expiry_on_another_host_never_probes_the_pid", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("old", w, { hostname: "host-z", expiresAt: w.clock() + 1_000, pid: 7 }));
  const probed: number[] = [];
  const b = bot(w, "sess-b", { kill: (p) => void probed.push(p) });
  b.b.start();
  await w.advance(30_000);
  assert.equal(lease(w).sessionId, "old", "not expired, other host: alive by TTL");
  await w.advance(60_000);
  assert.equal(lease(w).sessionId, "sess-b", "expired: takeover");
  assert.deepEqual(probed, []);
  b.b.dispose();
});

test("prbot_stale_by_dead_pid_on_this_host_with_a_reread_before_writing", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("old", w, { pid: 777 }));
  const b = bot(w, "sess-b", {
    random: 0.5,
    kill: (p) => {
      if (p === 777) throw Object.assign(new Error("x"), { code: "ESRCH" });
    },
  });
  b.b.start();
  await w.advance(1_000);
  // during the jitter wait (2.5 s) someone else takes the lease: the re-read keeps us out
  w.memfs.put(LEASE, leaseOf("sess-c", w, { pid: 888 }));
  await w.advance(10_000);
  assert.equal(lease(w).sessionId, "sess-c");
  assert.equal(b.outcomes("lease_acquired").length, 0);
  b.b.dispose();
});

test("prbot_dead_pid_takeover_without_interference", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("old", w, { pid: 777 }));
  const b = bot(w, "sess-b", { kill: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); } });
  b.b.start();
  await w.advance(10_000);
  assert.equal(lease(w).sessionId, "sess-b");
  b.b.dispose();
});

test("prbot_eperm_means_the_pid_is_alive", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("old", w, { pid: 777 }));
  const b = bot(w, "sess-b", { kill: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); } });
  b.b.start();
  await w.advance(120_000);
  assert.equal(lease(w).sessionId, "old");
  assert.match(b.b.describe(), /\(follower;/);
  b.b.dispose();
});

test("prbot_lease_renews_on_its_own_timer_while_a_source_is_backed_off", async () => {
  const w = world();
  const a = bot(w, "sess-a", { handlers: { pr_poll: () => hostFail("gh: secondary rate limit exceeded") } });
  a.b.start();
  await w.advance(0);
  const first = lease(w).renewedAt as number;
  await w.advance(60_000);
  const second = lease(w).renewedAt as number;
  await w.advance(60_000);
  const third = lease(w).renewedAt as number;
  assert.ok(second > first && third > second, "renewed every `seconds`");
  assert.ok((a.outcomes("backoff").length) > 0, "the source is backed off meanwhile");
  assert.equal(lease(w).expiresAt as number - third, 300_000, "TTL is max(300 s, 3 x seconds)");
  a.b.dispose();
});

test("prbot_ttl_is_three_times_seconds_above_100_seconds", async () => {
  const w = world();
  const a = bot(w, "sess-a", { cfg: { ...CFG, seconds: 180 } });
  a.b.start();
  await w.advance(0);
  assert.equal((lease(w).expiresAt as number) - (lease(w).renewedAt as number), 540_000);
  a.b.dispose();
});

test("prbot_leader_steps_down_silently_when_replaced", async () => {
  const w = world();
  const a = bot(w, "sess-a");
  a.b.start();
  await w.advance(0);
  const before = a.calls.length;
  w.memfs.put(LEASE, leaseOf("sess-z", w, { expiresAt: w.clock() + 100_000_000 }));
  await w.advance(60_000);
  assert.equal(a.outcomes("lease_lost").length, 1);
  assert.match(a.b.describe(), /\(follower;/);
  const after = a.calls.length;
  await w.advance(600_000);
  assert.equal(a.calls.length, after, "no polling after the step-down");
  assert.ok(before > 0);
  assert.equal(lease(w).sessionId, "sess-z", "the replaced leader does not touch the lease");
  a.b.dispose();
});

test("prbot_release_at_shutdown_removes_only_our_lease", async () => {
  const w = world();
  const a = bot(w, "sess-a");
  a.b.start();
  await w.advance(0);
  a.b.dispose();
  assert.equal(w.memfs.files.has(LEASE), false);
  assert.equal(a.outcomes("released").length, 1);

  const c = bot(w, "sess-c");
  const d = bot(w, "sess-d");
  c.b.start();
  d.b.start();
  await w.advance(0);
  d.b.dispose();
  assert.equal(lease(w).sessionId, "sess-c", "a follower's shutdown leaves the leader's lease");
  c.b.dispose();
});

test("prbot_follower_never_polls_and_takes_over_only_a_stale_lease", async () => {
  const w = world();
  w.memfs.put(LEASE, leaseOf("sess-a", w, { expiresAt: w.clock() + 100_000_000 }));
  const b = bot(w, "sess-b");
  b.b.start();
  await w.advance(600_000);
  assert.equal(b.calls.length, 0);
  assert.equal(lease(w).sessionId, "sess-a");
  b.b.dispose();
});

test("prbot_children_and_a_disabled_watch_do_not_participate", async () => {
  const w = world();
  const child = bot(w, "child", { active: false });
  child.b.start();
  const off = bot(w, "off", { cfg: { enabled: false } });
  off.b.start();
  await w.advance(600_000);
  assert.equal(w.memfs.files.size, 0);
  assert.equal(child.calls.length + off.calls.length, 0);
  assert.equal(child.b.describe(), "pr shared watch: off");
  assert.equal(off.b.describe(), "pr shared watch: off");
});

test("prbot_runs_the_ops_with_the_session_cwd", async () => {
  const w = world();
  const a = bot(w, "sess-a");
  a.b.start();
  await w.advance(0);
  assert.ok(a.calls.length > 0);
  assert.ok(a.calls.every((c) => c.cwd === "/work/leader"));
  a.b.dispose();
});

// ------------------------------------------------------------------ notifications

const thread = (repo: string, n: number) => ({ repo, n, title: `t${n}`, url: url(repo, n) });

test("prbot_notifications_use_if_modified_since_and_a_304_is_unchanged_not_a_failure", async () => {
  const w = world();
  let n = 0;
  const a = bot(w, "sess-a", {
    handlers: {
      pr_poll: (args) => {
        if (args.endpoint !== "notifications") return poll(304);
        n += 1;
        if (n === 1) return poll(200, { lastModified: "Sun, 25 Oct 2026 07:00:00 GMT", items: [thread("acme/web", 5)] });
        return poll(304, { lastModified: "Sun, 25 Oct 2026 07:00:00 GMT" });
      },
      pr_batch: () => ran({ action: "pr_batch", prs: [{ repo: "acme/web", number: 5, state: "open", title: "fresh title", checks: { failed: [], counts: {} } }], errors: [] }),
    },
  });
  a.b.start();
  await w.advance(0);
  const polls = () => a.ops("pr_poll").filter((c) => c.args.endpoint === "notifications");
  assert.equal(polls()[0].args.since, undefined, "a new leader starts unconditionally");
  await w.advance(60_000);
  const second = polls().find((c) => c.args.since);
  assert.equal(second?.args.since, "Sun, 25 Oct 2026 07:00:00 GMT");
  assert.equal(second?.args.page, 1);
  assert.equal(a.outcomes("error").length, 0, "a 304 is never a failure");
  assert.ok(a.traces.some((t) => t.outcome === "unchanged" && t.source === "notifications"));
  assert.equal(snap(w).review.length, 1, "items are kept on a 304");
  assert.equal(snap(w).review[0].title, "fresh title");
  assert.equal(snap(w).degraded, false);
  a.b.dispose();
});

test("prbot_x_poll_interval_is_honoured_over_seconds", async () => {
  const w = world();
  const a = bot(w, "sess-a", { cfg: { ...CFG, events: false }, handlers: { pr_poll: () => poll(200, { pollInterval: 300 }) } });
  a.b.start();
  await w.advance(0);
  const polls = () => a.ops("pr_poll").length;
  assert.equal(polls() > 0, true);
  const base = polls();
  await w.advance(240_000);
  assert.equal(polls(), base, "no poll before 300 s although seconds is 60");
  await w.advance(61_000);
  assert.ok(polls() > base);
  a.b.dispose();
});

test("prbot_a_200_reads_three_pages_and_review_items_go_through_batch_per_host", async () => {
  const w = world();
  const pages: number[] = [];
  const batches: Record<string, unknown>[] = [];
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, events: false, authors: [] },
    handlers: {
      pr_poll: (args) => {
        pages.push(args.page as number);
        const p = args.page as number;
        return poll(200, { items: [thread(`acme/p${p}`, p), ...(p === 3 ? [{ repo: "acme/x", n: 9, title: "ghe", url: url("acme/x", 9, "ghe.example.invalid") }] : [])] });
      },
      pr_batch: (args) => {
        batches.push(args);
        const prs = args.prs as { repo: string; n: number }[];
        return ran({
          action: "pr_batch",
          prs: prs.filter((p) => p.n !== 2).map((p) => ({ repo: p.repo, number: p.n, state: p.n === 3 ? "merged" : "open", title: `T${p.n}`, checks: { failed: [], counts: {} } })),
          errors: prs.filter((p) => p.n === 2).map((p) => ({ repo: p.repo, number: p.n, kind: "pr_not_found" })),
        });
      },
    },
  });
  a.b.start();
  await w.advance(0);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(batches.length, 2, "one batch per host");
  assert.deepEqual(batches.map((b) => b.host).sort(), ["ghe.example.invalid", "github.com"]);
  const titles = snap(w).review.map((r: any) => `${r.host}:${r.repo}#${r.n}`).sort();
  assert.deepEqual(titles, ["ghe.example.invalid:acme/x#9", "github.com:acme/p1#1"], "closed, merged and not-found PRs are dropped");
  a.b.dispose();
});

test("prbot_403_on_notifications_switches_to_the_search_fallback_once", async () => {
  const w = world();
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, events: false, authors: [] },
    handlers: {
      pr_poll: () => poll(403),
      pr_search: (args) => (args.reviewRequested ? ran({ action: "pr_search", prs: [{ number: 7, url: url("acme/web", 7), title: "needs review", repository: "acme/web" }] }) : ran({ action: "pr_search", prs: [] })),
    },
  });
  a.b.start();
  await w.advance(0);
  await w.advance(200_000);
  assert.equal(a.outcomes("notifications_fallback").length, 1);
  assert.equal(a.ops("pr_poll").length, 1, "the notifications endpoint is not tried again");
  assert.ok(a.ops("pr_search").filter((c) => c.args.reviewRequested === true).length >= 3);
  assert.equal(snap(w).sources.notifications, "fallback");
  assert.equal(snap(w).review[0].n, 7);
  assert.match(a.b.describe(), /notifications fallback/);
  a.b.dispose();
});

test("prbot_404_on_notifications_also_falls_back", async () => {
  const w = world();
  const a = bot(w, "sess-a", { cfg: { ...CFG, events: false }, handlers: { pr_poll: () => poll(404) } });
  a.b.start();
  await w.advance(0);
  assert.equal(a.outcomes("notifications_fallback").length, 1);
  a.b.dispose();
});

// ------------------------------------------------------------------ failing PRs

test("prbot_failing_prs_search_per_author_then_one_batch_per_host", async () => {
  const w = world();
  const batches: Record<string, unknown>[] = [];
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, authors: ["ci-bot", "dep-bot"], events: false },
    handlers: {
      pr_poll: () => poll(304),
      pr_search: (args) => ran({ action: "pr_search", prs: args.author === "ci-bot" ? [{ number: 1, url: url("acme/a", 1), title: "one" }, { number: 2, url: url("acme/a", 2), title: "two" }] : [{ number: 2, url: url("acme/a", 2), title: "two" }, { number: 3, url: url("acme/b", 3), title: "three" }] }),
      pr_batch: (args) => {
        batches.push(args);
        const prs = args.prs as { repo: string; n: number }[];
        return ran({ action: "pr_batch", prs: prs.map((p) => ({ repo: p.repo, number: p.n, state: "open", title: `T${p.n}`, checks: { failed: p.n === 2 ? ["test"] : [], counts: { failed: p.n === 2 ? 1 : 0 } } })), errors: [] });
      },
    },
  });
  a.b.start();
  await w.advance(0);
  const searches = a.ops("pr_search").filter((c) => c.args.author);
  assert.deepEqual(searches.map((c) => c.args.author), ["ci-bot", "dep-bot"]);
  assert.equal(batches.length, 1);
  assert.deepEqual((batches[0].prs as unknown[]).length, 3, "the union, de-duplicated");
  assert.deepEqual(snap(w).failing.map((f: any) => f.n), [2]);
  assert.equal(snap(w).failing[0].title, "T2");
  a.b.dispose();
});

test("prbot_the_failing_union_is_capped_at_50", async () => {
  const w = world();
  let sent = 0;
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, events: false },
    handlers: {
      pr_poll: () => poll(304),
      pr_search: () => ran({ action: "pr_search", prs: Array.from({ length: 60 }, (_, i) => ({ number: i + 1, url: url("acme/a", i + 1), title: "t" })) }),
      pr_batch: (args) => {
        sent = (args.prs as unknown[]).length;
        return ran({ action: "pr_batch", prs: [], errors: [] });
      },
    },
  });
  a.b.start();
  await w.advance(0);
  assert.equal(sent, 50);
  a.b.dispose();
});

test("prbot_a_pr_in_both_groups_is_listed_once_as_failing_and_the_lists_are_capped_and_ordered", async () => {
  const w = world();
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, events: false },
    handlers: {
      pr_poll: () => poll(200, { items: [thread("acme/z", 1), thread("acme/a", 2), thread("acme/a", 1), ...Array.from({ length: 45 }, (_, i) => thread("acme/m", i + 10))] }),
      pr_search: () => ran({ action: "pr_search", prs: [{ number: 2, url: url("acme/a", 2), title: "dup" }] }),
      pr_batch: (args) =>
        ran({ action: "pr_batch", prs: (args.prs as { repo: string; n: number }[]).map((p) => ({ repo: p.repo, number: p.n, state: "open", title: "t", checks: { failed: ["x"], counts: { failed: p.repo === "acme/a" && p.n === 2 ? 1 : 0 } } })), errors: [] }),
    },
  });
  a.b.start();
  await w.advance(0);
  const s = snap(w);
  assert.deepEqual(s.failing.map((f: any) => `${f.repo}#${f.n}`), ["acme/a#2"]);
  assert.ok(!s.review.some((r: any) => r.repo === "acme/a" && r.n === 2));
  assert.equal(s.review.length + s.failing.length, 40);
  assert.deepEqual(s.review.slice(0, 2).map((r: any) => `${r.repo}#${r.n}`), ["acme/a#1", "acme/m#10"]);
  a.b.dispose();
});

// ------------------------------------------------------------------ events

test("prbot_events_use_if_none_match_a_304_is_free_and_login_is_asked_once", async () => {
  const w = world();
  const hours = (h: number) => new Date(w.clock() - h * 3600_000).toISOString();
  let n = 0;
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, authors: [] },
    handlers: {
      pr_poll: (args) => {
        if (args.endpoint === "notifications") return poll(304);
        n += 1;
        if (n === 1) return poll(200, { etag: '"abc"', items: [{ repo: "acme/web", n: 5, url: url("acme/web", 5), at: hours(1) }, { repo: "acme/web", n: 5, url: url("acme/web", 5), at: hours(0.5) }, { repo: "acme/web", n: 6, url: url("acme/web", 6), at: hours(30) }] });
        return poll(304);
      },
    },
  });
  a.b.start();
  await w.advance(0);
  const ev = () => a.ops("pr_poll").filter((c) => c.args.endpoint === "events");
  assert.equal(ev()[0].args.login, "me-user");
  assert.equal(ev()[0].args.etag, undefined);
  assert.equal(snap(w).touched.length, 1, "duplicates reduced, items older than 24 h dropped");
  assert.equal(snap(w).touched[0].n, 5);
  await w.advance(60_000);
  assert.equal(ev()[1].args.etag, '"abc"');
  assert.equal(a.ops("pr_login").length, 1);
  assert.equal(snap(w).touched.length, 1, "a 304 keeps the items");
  assert.equal(a.outcomes("error").length, 0);
  a.b.dispose();
});

test("prbot_touched_items_age_out_after_24_hours", async () => {
  const w = world();
  let first = true;
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, authors: [], seconds: 3600 },
    handlers: {
      pr_poll: (args) => {
        if (args.endpoint === "notifications") return poll(304);
        if (first) {
          first = false;
          return poll(200, { etag: '"e"', items: [{ repo: "acme/web", n: 5, url: url("acme/web", 5), at: new Date(w.clock() - 20 * 3600_000).toISOString() }] });
        }
        return poll(304);
      },
    },
  });
  a.b.start();
  await w.advance(0);
  assert.equal(snap(w).touched.length, 1);
  await w.advance(5 * 3600_000);
  assert.equal(snap(w).touched.length, 0);
  a.b.dispose();
});

test("prbot_403_on_events_turns_the_source_off_with_one_trace", async () => {
  const w = world();
  const a = bot(w, "sess-a", { handlers: { pr_poll: (args) => (args.endpoint === "events" ? poll(403) : poll(304)) } });
  a.b.start();
  await w.advance(0);
  const n = a.ops("pr_poll").filter((c) => c.args.endpoint === "events").length;
  await w.advance(600_000);
  assert.equal(a.ops("pr_poll").filter((c) => c.args.endpoint === "events").length, n);
  assert.equal(a.outcomes("events_unavailable").length, 1);
  assert.equal(snap(w).sources.events, "off");
  assert.match(a.b.describe(), /events off/);
  a.b.dispose();
});

test("prbot_the_login_is_never_written_to_a_file_or_a_trace", async () => {
  const w = world();
  const a = bot(w, "sess-a", { handlers: { pr_poll: (args) => (args.endpoint === "events" ? poll(200, { etag: '"e"', items: [{ repo: "acme/web", n: 5, url: url("acme/web", 5), at: new Date(w.clock()).toISOString() }] }) : poll(304)) } });
  a.b.start();
  await w.advance(200_000);
  for (const f of w.memfs.writes) assert.ok(!f.text.includes("me-user"), f.path);
  assert.ok(!JSON.stringify(a.traces).includes("me-user"));
  a.b.dispose();
});

// ------------------------------------------------------------------ snapshot and files

test("prbot_only_the_listed_keys_reach_the_files_and_traces", async () => {
  const w = world();
  const a = bot(w, "sess-a", {
    handlers: {
      pr_poll: (args) => (args.endpoint === "events" ? poll(200, { etag: '"e"', items: [{ repo: "acme/web", n: 5, url: url("acme/web", 5), at: new Date(w.clock()).toISOString() }] }) : poll(200, { items: [thread("acme/web", 8)] })),
      pr_search: () => ran({ action: "pr_search", prs: [{ number: 3, url: url("acme/web", 3), title: "x" }] }),
      pr_batch: (args) => ran({ action: "pr_batch", prs: (args.prs as { repo: string; n: number }[]).map((p) => ({ repo: p.repo, number: p.n, state: "open", title: "t", checks: { failed: ["c"], counts: { failed: 1 } } })), errors: [] }),
    },
  });
  a.b.start();
  await w.advance(130_000);
  assert.deepEqual(Object.keys(lease(w)).sort(), ["acquiredAt", "expiresAt", "hostname", "pid", "renewedAt", "sessionId"]);
  assert.deepEqual(Object.keys(snap(w)).sort(), ["at", "degraded", "failing", "intervalSeconds", "leader", "review", "sources", "touched"]);
  assert.deepEqual(Object.keys(snap(w).sources).sort(), ["events", "notifications"]);
  assert.deepEqual(Object.keys(snap(w).failing[0]).sort(), ["host", "n", "repo", "title", "url"]);
  assert.deepEqual(Object.keys(snap(w).touched[0]).sort(), ["at", "host", "n", "repo", "url"]);
  assert.deepEqual([...new Set(w.memfs.writes.map((x) => x.path))].sort(), [LEASE, SNAP]);
  for (const t of a.traces.filter((x) => x.event === "pr_shared")) {
    assert.ok(Object.keys(t).every((k) => ["event", "outcome", "source", "count"].includes(k)), JSON.stringify(t));
    assert.ok(!/acme|web|ci-bot|me-user/.test(JSON.stringify(t)));
  }
  assert.equal(typeof snap(w).at, "number");
  a.b.dispose();
});

test("prbot_snapshot_is_written_on_change_and_as_a_heartbeat_each_interval", async () => {
  const w = world();
  const a = bot(w, "sess-a", { cfg: { ...CFG, events: false, authors: [] }, handlers: { pr_poll: () => poll(304) } });
  a.b.start();
  await w.advance(0);
  const snapshotWrites = () => w.memfs.writes.filter((x) => x.path === SNAP).length;
  const n0 = snapshotWrites();
  assert.equal(n0, 1);
  await w.advance(60_000);
  assert.ok(snapshotWrites() > n0, "the heartbeat keeps `at` fresh");
  assert.ok(snap(w).at >= w.clock() - 61_000);
  a.b.dispose();
});

test("prbot_real_fs_exclusive_create_atomic_write_and_mtime_read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prbot-"));
  try {
    const target = path.join(dir, "prbot");
    const w = world();
    const mk = (id: string) =>
      bot(w, id, {
        fs: realFs,
        dir: target,
        handlers: { pr_poll: (args) => (args.endpoint === "events" ? poll(304) : poll(200, { items: [thread("acme/web", 8)] })), pr_batch: () => ran({ action: "pr_batch", prs: [{ repo: "acme/web", number: 8, state: "open", title: "T8", checks: { failed: [], counts: {} } }], errors: [] }) },
      });
    const a = mk("sess-a");
    const b = mk("sess-b");
    a.b.start();
    b.b.start();
    await w.advance(0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "lease.json"), "utf8")).sessionId, "sess-a");
    assert.deepEqual(fs.readdirSync(target).sort(), ["lease.json", "snapshot.json"], "no temp files left");
    const got = b.b.read();
    assert.equal(got?.review[0].n, 8);
    assert.equal(b.b.read(), got, "unchanged mtime: the parsed object is reused");
    assert.equal(fs.statSync(path.join(target, "snapshot.json")).mode & 0o077, 0);
    a.b.dispose();
    b.b.dispose();
    assert.equal(fs.existsSync(path.join(target, "lease.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prbot_reader_reparses_only_when_the_file_changed", () => {
  const w = world();
  const b = bot(w, "sess-b");
  const body = (n: number) => JSON.stringify({ at: T0, intervalSeconds: 60, degraded: false, sources: { notifications: "ok", events: "ok" }, review: [{ host: "github.com", repo: "acme/web", n, title: "t", url: url("acme/web", n) }], failing: [], touched: [] });
  w.memfs.put(SNAP, body(1), T0);
  const first = b.b.read();
  const reads = w.memfs.reads;
  assert.equal(b.b.read(), first);
  assert.equal(w.memfs.reads, reads, "no file read when mtime and size are unchanged");
  w.memfs.put(SNAP, body(2), T0 + 5);
  assert.equal(b.b.read()?.review[0].n, 2);
  w.memfs.files.delete(SNAP);
  assert.equal(b.b.read(), null);
});

test("prbot_snapshot_shape_check_size_cap_and_sanitising", () => {
  const good = { at: T0, intervalSeconds: 60, degraded: false, sources: { notifications: "ok", events: "ok" }, review: [], failing: [], touched: [] };
  assert.ok(parseSnapshot(JSON.stringify(good)));
  assert.equal(parseSnapshot("not json"), null);
  assert.equal(parseSnapshot(""), null);
  assert.equal(parseSnapshot("[]"), null);
  for (const bad of [{ ...good, at: "x" }, { ...good, intervalSeconds: 0 }, { ...good, degraded: "no" }, { ...good, review: {} }, { ...good, touched: null }]) assert.equal(parseSnapshot(JSON.stringify(bad)), null);
  assert.equal(parseSnapshot(JSON.stringify({ ...good, title: "x".repeat(130 * 1024) })), null, "128 KB cap");
  const mixed = parseSnapshot(
    JSON.stringify({
      ...good,
      extra: 1,
      sources: { notifications: "weird", events: "off" },
      review: [
        { host: "github.com", repo: "acme/web", n: 1, title: "a\u0085b\u001b[31mc\u200bd", url: "https://github.com/acme/web/pull/1" },
        { host: "github.com", repo: "../x", n: 2, title: "bad repo", url: null },
        { host: "github.com", repo: "acme/web", n: 0, title: "bad n", url: null },
        { host: "github.com", repo: "acme/web", n: 3, title: "bad url", url: "javascript:alert(1)" },
        { host: "bad host", repo: "acme/web", n: 4, title: "bad host", url: null },
        "x",
      ],
      touched: [{ host: "github.com", repo: "acme/web", n: 1, url: null, at: 5 }, { host: "github.com", repo: "acme/web", n: 2, url: null, at: "x" }],
    }),
  );
  assert.ok(mixed);
  assert.deepEqual(mixed.sources, { events: "off" });
  assert.deepEqual(mixed.review.map((r) => r.n), [1, 3]);
  assert.equal(mixed.review[0].title, "ab[31mcd");
  assert.equal(mixed.review[1].url, null);
  assert.equal(mixed.touched.length, 1);
  const many = parseSnapshot(JSON.stringify({ ...good, review: Array.from({ length: 80 }, (_, i) => ({ host: "github.com", repo: "acme/web", n: i + 1, title: "t", url: null })) }));
  assert.equal(many?.review.length, 40);
});

test("prbot_parse_lease_is_strict", () => {
  assert.equal(parseLease(""), null);
  assert.equal(parseLease("{}"), null);
  assert.equal(parseLease(JSON.stringify({ sessionId: "a", pid: 0, hostname: "h", acquiredAt: 1, renewedAt: 1, expiresAt: 2 })), null);
  assert.ok(parseLease(JSON.stringify({ sessionId: "a", pid: 3, hostname: "h", acquiredAt: 1, renewedAt: 1, expiresAt: 2 })));
});

// ------------------------------------------------------------------ backoff, degraded, halt

test("prbot_three_failures_in_a_row_double_the_interval_and_set_degraded", async () => {
  const w = world();
  let fail = true;
  const a = bot(w, "sess-a", { cfg: { ...CFG, events: false }, handlers: { pr_poll: () => (fail ? hostFail("gh: server error") : poll(304)) } });
  a.b.start();
  await w.advance(0);
  const times = () => a.ops("pr_poll").map((c) => c.at - T0);
  await w.advance(60_000 * 2);
  assert.deepEqual(times(), [0, 60_000, 120_000]);
  assert.equal(snap(w).degraded, true, "third failure in a row");
  await w.advance(60_000);
  assert.equal(a.ops("pr_poll").length, 3, "the next poll is 120 s after the third failure");
  await w.advance(60_000);
  assert.equal(a.ops("pr_poll").length, 4);
  fail = false;
  await w.advance(10 * 60_000);
  assert.equal(snap(w).degraded, false, "a success clears degraded");
  a.b.dispose();
});

test("prbot_a_rate_limit_message_doubles_at_once_and_the_cap_is_30_minutes", async () => {
  const w = world();
  const a = bot(w, "sess-a", { cfg: { ...CFG, events: false, authors: [] }, handlers: { pr_poll: () => hostFail("gh: API rate limit exceeded (HTTP 403)") } });
  a.b.start();
  await w.advance(0);
  assert.equal(snap(w).degraded, true);
  assert.equal(a.outcomes("backoff").length, 1);
  await w.advance(24 * 3600_000);
  const t = a.ops("pr_poll").map((c) => c.at);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.equal(Math.max(...gaps), MAX_BACKOFF_MS);
  assert.equal(gaps[0], 120_000);
  a.b.dispose();
});

test("prbot_graphql_rate_limited_from_batch_backs_off_the_search_source", async () => {
  const w = world();
  const a = bot(w, "sess-a", {
    cfg: { ...CFG, events: false },
    handlers: { pr_poll: () => poll(304), pr_search: () => ran({ action: "pr_search", prs: [{ number: 1, url: url("acme/a", 1), title: "t" }] }), pr_batch: () => hostFail("gh: GraphQL RATE_LIMITED") },
  });
  a.b.start();
  await w.advance(0);
  assert.equal(snap(w).degraded, true);
  assert.equal(a.ops("pr_batch").length, 1);
  await w.advance(100_000);
  assert.equal(a.ops("pr_batch").length, 1, "doubled to 120 s");
  a.b.dispose();
});

test("prbot_auth_or_host_missing_halts_and_releases_the_lease", async () => {
  for (const code of ["pr_auth_missing", "pr_host_missing"]) {
    const w = world();
    const a = bot(w, "sess-a", { handlers: { pr_poll: () => pre(code), pr_search: () => pre(code), pr_login: () => pre(code) } });
    a.b.start();
    await w.advance(0);
    assert.equal(w.memfs.files.has(LEASE), false, code);
    assert.equal(a.outcomes("stopped").length, 1);
    assert.equal(a.outcomes("released").length, 1);
    const n = a.calls.length;
    await w.advance(3600_000);
    assert.equal(a.calls.length, n, "a stopped bot does not poll or contend again");
    assert.equal(w.memfs.files.has(LEASE), false);
    assert.match(a.b.describe(), /stopped/);
    a.b.dispose();
  }
});

// ------------------------------------------------------------------ hosts

test("prbot_glab_answers_unsupported_and_every_built_in_source_goes_off", async () => {
  const w = world();
  const a = bot(w, "sess-a", { handlers: { pr_poll: () => pre("pr_unsupported"), pr_search: () => pre("pr_unsupported"), pr_login: () => pre("pr_unsupported") } });
  a.b.start();
  await w.advance(0);
  const n = a.calls.length;
  await w.advance(600_000);
  assert.equal(a.calls.length, n);
  assert.equal(snap(w).sources.notifications, "off");
  assert.equal(snap(w).sources.events, "off");
  assert.match(a.b.describe(), /failing group needs gh/);
  a.b.dispose();
});

test("prbot_template_hosts_run_only_the_author_search_and_show_review_requested_results", async () => {
  const w = world();
  const a = bot(w, "sess-a", {
    prHost: { search: ["tool", "{author}"] },
    cfg: { ...CFG, authors: ["ci-bot", "dep-bot"] },
    handlers: {
      pr_search: (args) => ran({ action: "pr_search", prs: [{ number: 4, url: "https://git.example.invalid/acme/web/-/merge_requests/4", title: "mine", reviewRequested: true }, { number: 5, url: "https://git.example.invalid/acme/web/-/merge_requests/5", title: "other" }] }),
    },
  });
  a.b.start();
  await w.advance(130_000);
  assert.deepEqual([...new Set(a.calls.map((c) => c.op))], ["pr_search"]);
  assert.deepEqual(a.ops("pr_search").slice(0, 2).map((c) => c.args), [{ author: "ci-bot" }, { author: "dep-bot" }]);
  const s = snap(w);
  assert.deepEqual(s.review.map((r: any) => [r.host, r.n]), [["git.example.invalid", 4]]);
  assert.deepEqual(s.failing, []);
  assert.deepEqual(s.sources, { notifications: "off", events: "off" });
  assert.match(a.b.describe(), /failing group needs gh/);
  a.b.dispose();
});

// ------------------------------------------------------------------ doctor

test("prbot_doctor_line_variants", async () => {
  const w = world();
  const off = bot(w, "x", { cfg: { enabled: false } });
  off.b.start();
  assert.equal(off.b.describe(), "pr shared watch: off");

  const a = bot(w, "sess-a", { cfg: { ...CFG, authors: ["ci-bot", "dep-bot"] }, handlers: { pr_poll: (args) => (args.endpoint === "events" ? poll(403) : poll(304)) } });
  a.b.start();
  assert.match(a.b.describe(), /^pr shared watch: on \(follower;/);
  await w.advance(0);
  assert.equal(a.b.describe(), "pr shared watch: on (leader; notifications ok, events off, 2 authors)");

  const f = bot(w, "sess-f", { cfg: { ...CFG, authors: ["ci-bot"] } });
  f.b.start();
  await w.advance(0);
  assert.equal(f.b.describe(), "pr shared watch: on (follower; notifications ok, events off, 1 author)", "a follower reports what the snapshot says");
  a.b.dispose();
  f.b.dispose();
});

test("prbot_doctor_warns_for_a_project_or_session_value", () => {
  const lines = sharedDoctorLines("pr shared watch: off", ["project tools.prShared ignored: the project may not set this key (x)", "session tools.prHost ignored: y"]);
  assert.deepEqual(lines, ["INFO pr shared watch: off", "WARN pr shared watch: project tools.prShared ignored: the project may not set this key (x)"]);
  assert.deepEqual(sharedDoctorLines("pr shared watch: off", []), ["INFO pr shared watch: off"]);
});
