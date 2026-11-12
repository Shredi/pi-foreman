// A child foreman session whose watched PR merged removes its worktree and branch whichever way the close starts:
// by the watch's merged event (`pr-merged`), or by a parent's `foreman:close` after the merge (the watch ended silently
// in the pre-close refresh, or the self-close was refused). Real PrWatches, real CloseFlow, real selfFinish and the real
// foreman_close.py on temp git repositories; the cleanup spawn is recorded, never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CloseFlow, prMergedPrompt } from "../close.ts";
import type { CloseDeps, CloseReport, CloseRequest } from "../close.ts";
import { latestWatches, PrWatches, PRWATCH_ENTRY } from "../prwatch.ts";
import type { Timers, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import { samePath, selfFinish } from "../selffinish.ts";
import { storeFromPoll } from "./_storefake.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "..", "scripts", "foreman_close.py");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const snap = (state: WatchSnapshot["state"] = "open"): WatchSnapshot => ({ state, mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [] });

const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG_")));
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitcfg-")), "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
const run = (cmd: string, args: string[], cwd: string): string => execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const git = (cwd: string, ...args: string[]): string => run("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], cwd);
const py = (args: string[]): Promise<string> => new Promise((resolve) => execFile(PY, ["-E", "-s", SCRIPT, ...args], { encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG } }, (_err, stdout) => resolve(String(stdout))));
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result });

/** main checkout `repo`, the round's worktree `wt` on branch `feat` (the session's cwd) whose commit was squash-merged into main. */
function buildTemplate() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-merged-cleanup-tpl-")));
  const state = path.join(root, "agent", "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  const origin = path.join(root, "origin.git");
  run("git", ["init", "-q", "--bare", "-b", "main", origin], root);
  const repo = path.join(root, "repo");
  run("git", ["clone", "-q", origin, repo], root);
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".workflow/\n*.env\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  const wt = path.join(root, "repo.worktrees", "feat");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  fs.writeFileSync(path.join(wt, "f.txt"), "feature\n");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-q", "-m", "feature");
  const tip = git(wt, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", "feat");
  git(repo, "commit", "-q", "-m", "feature (squash)");
  git(repo, "push", "-q", "origin", "main");
  fs.mkdirSync(path.join(wt, ".workflow"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".workflow", "LEDGER-x.md"), "# ledger\n");
  return { root, tip };
}

// One template repository per test file (built on first use); each test gets a copy, so the git calls are spent once.
let template: ReturnType<typeof buildTemplate> | null = null;
process.on("exit", () => {
  if (template) fs.rmSync(template.root, { recursive: true, force: true });
});

/** A copy of the template repository (the absolute paths in the copied git files rewritten, no git call), or a `lite` world: the directories only, for a test that uses the fake self-finish. */
function world(lite = false) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-merged-cleanup-")));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "repo.worktrees", "feat");
  let tip = "0".repeat(40);
  if (lite) fs.mkdirSync(path.join(wt, ".workflow"), { recursive: true });
  else {
    template ??= buildTemplate();
    fs.cpSync(template.root, root, { recursive: true, preserveTimestamps: true });
    for (const f of [path.join(repo, ".git", "config"), path.join(repo, ".git", "worktrees", "feat", "gitdir"), path.join(wt, ".git")]) {
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").split(template.root).join(root));
    }
    tip = template.tip;
  }
  const state = path.join(root, "agent", "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  const handoff = path.join(root, "handoffs", "20261102-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  return { root, state, repo, wt, tip, handoff, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
type World = ReturnType<typeof world>;

interface RigOpts {
  /** What the pre-close pr_status says (default: merged). */
  fresh?: "open" | "merged" | "closed";
  report?: CloseReport;
  /** The PR head commit the self-finish's pr_status reports (default: the worktree's tip at the start). */
  headSha?: string;
  /** The result file is a real file (the stub and the appended section land on disk too), as in a real session. */
  disk?: boolean;
  /** A fake self-finish that starts the cleanup of `wt` and `feat` without any check (for a test that asserts nothing on git). */
  fake?: boolean;
  /** The pre-close pr_status waits for this promise. */
  gate?: Promise<void>;
}

/** A real PrWatches (child, the tracker's store a fake) and a CloseFlow with the real selfFinish, wired as index.ts does. */
function rig(w: World, o: RigOpts = {}) {
  const log: string[] = [];
  const files = new Map<string, string>();
  const spawned: string[][] = [];
  const remote: [string, string | undefined][] = [];
  const sent: unknown[] = [];
  const merged: unknown[] = [];
  let runs = 0;
  let waits: { id: string; kind: string; note: string }[] = [];
  let poll: WatchSnapshot = snap();
  let armed: (() => void) | null = null;
  const timers: Timers = { set: (fn) => ((armed = fn), 0), clear: () => undefined };
  let flow: CloseFlow;
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  const watches = new PrWatches({
    storeEntry: storeFromPoll(async () => ({ snap: poll })),
    send: (m) => void sent.push(m),
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers,
    child: () => true,
    fresh: async () => {
      await o.gate;
      return o.fresh ?? "merged";
    },
    onMerged: (i) => {
      merged.push(i);
      const file = path.join(w.handoff, "result.md");
      void Promise.resolve(flow.request({ source: "pr-merged", file, shown: file, prompt: prMergedPrompt(file, i.key.n), pr: { n: i.key.n, parent: "parent-1", label: "demo" } }, ctx)).catch(() => undefined);
    },
  });
  const deps: CloseDeps = {
    activeWaits: () => waits,
    activeRuns: () => runs,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: (t) => void log.push(`notify:${t}`),
    trace: (r) => void log.push(`trace:${r.decision}`),
    markCause: () => undefined,
    writeStub: (f, t) => {
      files.set(f, t);
      if (o.disk) fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, t);
    },
    exists: (f) => files.has(f),
    setTimer: () => () => undefined,
    report: o.report ? async () => o.report! : undefined,
    remoteReply: (kind, arg) => void remote.push([kind, arg]),
    watchedPrs: () => watches.numbers(),
    refreshWatched: () => watches.refresh(),
    mergedPr: () => watches.mergedPrs().at(-1)?.n ?? null,
    appendResult: (f, t) => {
      files.set(f, (files.get(f) ?? "") + t);
      if (o.disk) fs.appendFileSync(f, t);
    },
    selfFinish: (req) =>
      o.fake
        ? Promise.resolve({ lines: ["cleanup: started (fake)"], spawn: () => void spawned.push(["--ws", w.wt, "--branch", "feat"]) })
        : selfFinish({
        cwd: w.wt, handoff: w.handoff, sessionId: "child-1", stateDir: w.state, pid: 99999999, trusted: false, sinceMs: Date.now() - 60_000,
        status: async () => ran({ state: "merged", headRefName: "feat", baseRef: "main", headSha: o.headSha ?? w.tip }),
        git: async (a, dir) => git(dir ?? w.wt, ...a),
        closeScript: (a) => py(a),
        spawnCleanup: (a) => void spawned.push(a),
      }, req.pr!.n),
  };
  flow = new CloseFlow(deps);
  const idle = () => new Promise((r) => setImmediate(r));
  /** The watch's tick sees the merged PR (the tracker's stored snapshot says merged). */
  const merge = async (): Promise<void> => {
    poll = snap("merged");
    armed!();
    for (let i = 0; i < 1000 && watches.has(K); i++) await idle();
    await idle();
  };
  /** Send a close request and drive it through the model turn and the settle, as the close sequence expects. */
  const close = async (req: CloseRequest): Promise<void> => {
    await flow.request(req, ctx);
    await idle();
    await finish();
  };
  const finish = async (): Promise<void> => {
    const prompt = log.filter((l) => l.startsWith("prompt:")).at(-1)?.slice("prompt:".length);
    if (prompt) flow.onInput(prompt, "extension");
    flow.onModelReply("stop");
    await flow.onSettled(ctx);
  };
  const setRuns = (n: number): void => void (runs = n);
  const setWaits = (x: typeof waits): void => void (waits = x);
  return { log, files, spawned, remote, sent, merged, watches, flow: () => flow, ctx, merge, close, finish, idle, setRuns, setWaits };
}

const parentClose = (w: World): CloseRequest => ({ source: "intercom-parent", file: path.join(w.wt, ".workflow", "result.md"), replyTo: "parent-1" });
const replies = (log: string[]): string[] => log.filter((l) => l.startsWith("reply:parent-1:")).map((l) => l.slice("reply:parent-1:".length));
const argOf = (args: string[], flag: string): string => args[args.indexOf(flag) + 1];
const assertSpawnedFor = (w: World, spawned: string[][]): void => {
  assert.equal(spawned.length, 1, "one cleanup started");
  assert.ok(samePath(argOf(spawned[0], "--ws"), w.wt), spawned[0].join(" "));
  assert.equal(argOf(spawned[0], "--branch"), "feat");
};
const assertStays = (w: World): void => {
  assert.ok(fs.existsSync(w.wt), "worktree stays");
  assert.notEqual(git(w.repo, "branch", "--list", "feat"), "", "branch stays");
};

// ---------------------------------------------------------------- path (a): the watch's merged event

test("path a: the watch's merged event closes with source pr-merged and starts the cleanup of the worktree and branch", async () => {
  const w = world();
  try {
    const r = rig(w);
    r.watches.start(K, snap());
    await r.merge();
    assert.equal(r.merged.length, 1);
    await r.idle();
    await r.finish();
    assertSpawnedFor(w, r.spawned);
    assert.match(r.files.get(path.join(w.handoff, "result.md")) ?? "", /## Merge cleanup/);
  } finally {
    w.cleanup();
  }
});

test("path a: a merge close refused for an active child run tells the parent why", async () => {
  const w = world(true);
  try {
    const r = rig(w, { fake: true });
    r.setRuns(1);
    r.watches.start(K, snap());
    await r.merge();
    await r.idle();
    assert.equal(r.flow().active, false, "the self-close was refused");
    assert.ok(replies(r.log).some((t) => t.startsWith("pi-foreman: close refused: 1 child run(s) still active")), replies(r.log).join("\n"));
    assert.equal(r.spawned.length, 0);
  } finally {
    w.cleanup();
  }
});

test("path a: after a refused merge close, a later parent close still runs the cleanup", async () => {
  const w = world(true);
  try {
    const r = rig(w, { fake: true });
    r.setRuns(1);
    r.watches.start(K, snap());
    await r.merge();
    await r.idle();
    assert.equal(r.spawned.length, 0);
    r.setRuns(0);
    await r.close(parentClose(w));
    assertSpawnedFor(w, r.spawned);
    const out = replies(r.log);
    assert.ok(out.at(-1)!.startsWith("foreman:closed "), out.join("\n"));
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------- path (b): the parent's foreman:close after the merge

test("path b: the pre-close pr_status ends the merged watch, and the parent's close runs the cleanup of the worktree and branch", async () => {
  const w = world();
  try {
    const r = rig(w);
    r.watches.start(K, snap());
    await r.close(parentClose(w));
    assert.equal(r.watches.has(K), false);
    assert.equal(r.merged.length, 0, "the refresh stays silent: no onMerged");
    assert.equal(r.sent.length, 0, "and sends nothing to the model");
    assertSpawnedFor(w, r.spawned);
    assert.match(r.files.get(parentClose(w).file) ?? "", /## Merge cleanup/);
    assert.ok(replies(r.log).at(-1)!.startsWith("foreman:closed "));
  } finally {
    w.cleanup();
  }
});

test("path b: a remote parent's close runs the cleanup too; the closed notice stays the existing one", async () => {
  const w = world(true);
  try {
    const r = rig(w, { fake: true, report: { ready: true, removed: 0, handover: [], closeLine: "CLOSE: ready" } });
    r.watches.start(K, snap());
    await r.close({ source: "remote-parent", file: path.join(w.wt, ".workflow", "result.md") });
    assertSpawnedFor(w, r.spawned);
    assert.deepEqual(r.remote, [["closed", "ready"]]);
  } finally {
    w.cleanup();
  }
});

test("path b: a PR closed unmerged is not remembered; the parent's close does a plain close", async () => {
  const w = world(true);
  try {
    const r = rig(w, { fake: true, fresh: "closed" });
    r.watches.start(K, snap());
    await r.close(parentClose(w));
    assert.deepEqual(r.watches.mergedPrs(), []);
    assert.equal(r.spawned.length, 0);
    assert.ok(!r.log.some((l) => l.includes("merged, closing")));
    assert.ok(!(r.files.get(parentClose(w).file) ?? "").includes("## Merge cleanup"));
  } finally {
    w.cleanup();
  }
});

test("a close without any watched PR does a plain close: no self-finish, nothing spawned", async () => {
  const w = world(true);
  try {
    const r = rig(w, { fake: true });
    await r.close(parentClose(w));
    assert.equal(r.spawned.length, 0);
    assert.deepEqual(replies(r.log).map((t) => t.split(" ")[0]), ["foreman:closed"]);
  } finally {
    w.cleanup();
  }
});

test("a refused self-finish reaches the requester as its own reply before the foreman:closed line, which stays unchanged", async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.wt, "dirty.txt"), "d\n");
    const r = rig(w, { report: { ready: false, removed: 0, handover: [], closeLine: "CLOSE: open" } });
    r.watches.start(K, snap());
    await r.close(parentClose(w));
    const out = replies(r.log);
    assert.equal(out.length, 2, out.join("\n"));
    assert.ok(out[0].startsWith("PR #7 merged, closing (") && out[0].includes("cleanup: not started (worktree_dirty"), out[0]);
    assert.ok(!out[0].includes("\n"));
    assert.equal(out[1], `foreman:closed ${parentClose(w).file} CLOSE: open`);
    assert.equal(r.spawned.length, 0);
    assertStays(w);
  } finally {
    w.cleanup();
  }
});

test("a refused merge close for a pending wait that cannot be cancelled is reported to the parent, the merged PR stays remembered, and a later close runs the cleanup", async () => {
  const w = world(true);
  try {
    const r = rig(w, { fake: true });
    r.setWaits([{ id: "w1", kind: "pr", note: "" }]);
    r.watches.start(K, snap());
    await r.merge();
    await r.idle();
    assert.equal(r.flow().active, false, "the self-close was refused");
    assert.deepEqual(r.watches.mergedPrs().map((k) => k.n), [7]);
    assert.ok(replies(r.log).some((t) => t.startsWith("pi-foreman: close refused: 1 foreman_wait pending (w1 pr)")), replies(r.log).join("\n"));
    assert.equal(r.spawned.length, 0);
    r.setWaits([]);
    await r.close(parentClose(w));
    assertSpawnedFor(w, r.spawned);
    assert.ok(replies(r.log).at(-1)!.startsWith("foreman:closed "));
  } finally {
    w.cleanup();
  }
});

test("a merge seen while the parent's close checks the PR status: the parent hears no refusal, one foreman:closed, one cleanup", async () => {
  const w = world(true);
  try {
    let release!: () => void;
    const r = rig(w, { fake: true, gate: new Promise<void>((res) => void (release = res)) });
    r.watches.start(K, snap());
    const closing = Promise.resolve(r.flow().request(parentClose(w), r.ctx));
    await r.idle();
    await r.merge(); // the watch's merged event starts the pr-merged close during the status check
    assert.equal(r.merged.length, 1);
    release();
    await closing;
    await r.idle();
    await r.finish();
    const out = replies(r.log);
    assert.ok(!out.some((t) => t.includes("close refused")), out.join("\n"));
    assert.equal(out.filter((t) => t.startsWith("foreman:closed ")).length, 1, out.join("\n"));
    assert.equal(r.spawned.length, 1);
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------- uncommitted files of another repository (item 3)

test("a dirty repository outside the round (CLOSE: open) does not keep the worktree, on either path", async () => {
  const other = world();
  try {
    fs.writeFileSync(path.join(other.repo, "unrelated.txt"), "dirty\n");
    const open: CloseReport = { ready: false, removed: 0, handover: [], closeLine: "CLOSE: open" };
    for (const path_ of ["a", "b"]) {
      const w = world();
      try {
        const r = rig(w, { report: open });
        r.watches.start(K, snap());
        if (path_ === "a") {
          await r.merge();
          await r.idle();
          await r.finish();
        } else await r.close(parentClose(w));
        assertSpawnedFor(w, r.spawned);
      } finally {
        w.cleanup();
      }
    }
  } finally {
    other.cleanup();
  }
});

// ---------------------------------------------------------------- the refusals that protect work stay (item 5)

const refused: [string, (w: World) => void, RigOpts, RegExp][] = [
  ["unmerged commits: the branch tip is ahead of the PR head commit", (w) => {
    fs.writeFileSync(path.join(w.wt, "g.txt"), "more\n");
    git(w.wt, "add", "g.txt");
    git(w.wt, "commit", "-q", "-m", "after the merge");
  }, {}, /not_merged/],
  ["a modified tracked file", (w) => fs.writeFileSync(path.join(w.wt, "f.txt"), "edited\n"), {}, /worktree_dirty/],
  ["an untracked file", (w) => fs.writeFileSync(path.join(w.wt, "new.txt"), "n\n"), {}, /worktree_dirty/],
  ["an ignored file outside the disposable list", (w) => fs.writeFileSync(path.join(w.wt, "secrets.env"), "k=v\n"), {}, /ignored_files: secrets\.env/],
];

for (const [name, mutate, o, reason] of refused) {
  test(`parent close after the merge keeps the worktree and branch: ${name}`, async () => {
    const w = world();
    try {
      const staleTip = w.tip;
      mutate(w);
      const r = rig(w, { ...o, headSha: staleTip });
      r.watches.start(K, snap());
      await r.close(parentClose(w));
      assert.equal(r.spawned.length, 0);
      assertStays(w);
      const first = replies(r.log)[0];
      assert.ok(first.startsWith("PR #7 merged, closing (") && first.includes("cleanup: not started ("), first);
      assert.match(first, reason);
      assert.ok(replies(r.log).at(-1)!.startsWith("foreman:closed "));
    } finally {
      w.cleanup();
    }
  });
}

// ---------------------------------------------------------------- what the session remembers

const watchesOf = (extra: Partial<ConstructorParameters<typeof PrWatches>[0]> = {}) => {
  const sent: unknown[] = [];
  const merged: unknown[] = [];
  const entries: { watches: WatchRecord[]; merged?: PrKey[] }[] = [];
  let armed: (() => void) | null = null;
  let state: "open" | "merged" | "closed" = "open";
  let polled: WatchSnapshot["state"] = "open";
  const w = new PrWatches({
    storeEntry: storeFromPoll(async () => ({ snap: snap(polled) })),
    send: (m) => void sent.push(m),
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers: { set: (fn) => ((armed = fn), 0), clear: () => undefined },
    child: () => true,
    fresh: async () => state,
    onMerged: (i) => void merged.push(i),
    persist: (watches, mergedKeys) => void entries.push({ watches, merged: mergedKeys }),
    ...extra,
  });
  return { w, sent, merged, entries, setState: (s: typeof state) => void (state = s), armed: () => armed, setPolled: (s: WatchSnapshot["state"]) => void (polled = s) };
};

test("the pre-close refresh remembers a merged PR silently, and not a closed one", async () => {
  const m = watchesOf();
  m.w.start(K, snap());
  m.setState("closed");
  await m.w.refresh();
  assert.deepEqual(m.w.mergedPrs(), []);
  m.w.start(K, snap());
  m.setState("merged");
  await m.w.refresh();
  assert.deepEqual(m.w.mergedPrs().map((k) => k.n), [7]);
  assert.equal(m.sent.length, 0);
  assert.equal(m.merged.length, 0);
});

test("the remembered merged PR survives a reload with the watch entry", async () => {
  const m = watchesOf();
  m.w.start(K, snap());
  m.setState("merged");
  await m.w.refresh();
  const last = m.entries.at(-1)!;
  const entry = { type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s1", watches: last.watches, ...(last.merged ? { merged: last.merged } : {}) } };
  const again = watchesOf();
  again.w.restore(latestWatches([entry], "s1"));
  assert.deepEqual(again.w.mergedPrs().map((k) => k.n), [7]);
});

test("a session that does not remember merged PRs stores and persists none, on both ways a watch sees the merge", async () => {
  const m = watchesOf({ rememberMerged: () => false });
  m.w.start(K, snap());
  m.setState("merged");
  await m.w.refresh();
  m.w.start(K, snap());
  m.setPolled("merged");
  m.armed()!();
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
  assert.equal(m.merged.length, 1, "the watch's merged event fired");
  assert.deepEqual(m.w.mergedPrs(), []);
  assert.ok(m.entries.length > 0, "the watch set was still persisted");
  assert.ok(m.entries.every((e) => (e.merged ?? []).length === 0));
});

test("a session that remembers merged PRs persists them with the watch entry", async () => {
  const m = watchesOf({ rememberMerged: () => true });
  m.w.start(K, snap());
  m.setState("merged");
  await m.w.refresh();
  assert.deepEqual(m.w.mergedPrs().map((k) => k.n), [7]);
  assert.deepEqual(m.entries.at(-1)!.merged?.map((k) => k.n), [7]);
});

// ---------------------------------------------------------------- the result file of a parent's close outlives the worktree

test("a parent's close that starts the cleanup copies the finished result file into the handoff dir and names the copy; result.md stays", async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.handoff, "result.md"), "own result\n");
    const r = rig(w, { disk: true });
    r.watches.start(K, snap());
    const req = parentClose(w);
    await r.close(req);
    assertSpawnedFor(w, r.spawned);
    const copy = path.join(w.handoff, "result-2.md");
    assert.ok(fs.existsSync(copy), "the copy exists");
    assert.match(fs.readFileSync(copy, "utf8"), /## Merge cleanup/);
    assert.equal(fs.readFileSync(path.join(w.handoff, "result.md"), "utf8"), "own result\n");
    assert.equal(replies(r.log).at(-1), `foreman:closed ${copy}`);
  } finally {
    w.cleanup();
  }
});

test("a parent's close whose cleanup is refused copies nothing and names the original result file", async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.wt, "dirty.txt"), "d\n");
    const r = rig(w, { disk: true });
    r.watches.start(K, snap());
    const req = parentClose(w);
    await r.close(req);
    assert.equal(r.spawned.length, 0);
    assert.deepEqual(fs.readdirSync(w.handoff).filter((n) => n.endsWith(".md")), []);
    assert.equal(replies(r.log).at(-1), `foreman:closed ${req.file}`);
  } finally {
    w.cleanup();
  }
});

test("a failed copy of the result file does not stop the close or the cleanup; the reply names the original and a notice says so", async () => {
  const w = world();
  try {
    const r = rig(w); // the result file is not on disk: the copy fails
    r.watches.start(K, snap());
    const req = parentClose(w);
    await r.close(req);
    assertSpawnedFor(w, r.spawned);
    assert.equal(replies(r.log).at(-1), `foreman:closed ${req.file}`);
    assert.ok(r.log.some((l) => l.startsWith("notify:pi-foreman: could not keep a copy of the result file")), r.log.join("\n"));
    assert.ok(r.log.includes("shutdown"));
  } finally {
    w.cleanup();
  }
});
