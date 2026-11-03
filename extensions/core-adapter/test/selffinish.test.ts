// Self-finish of a child session whose PR was merged (ledger 7; plan Ruling items 5 and 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CloseFlow, prMergedPrompt } from "../close.ts";
import type { CloseDeps, SelfFinish } from "../close.ts";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import { selfFinish, spawnDetached, verifyMerged } from "../selffinish.ts";
import type { SelfFinishDeps } from "../selffinish.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "..", "scripts", "foreman_close.py");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const openSnap = (state: WatchSnapshot["state"] = "open"): WatchSnapshot => ({ state, mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [] });

// ---------------------------------------------------------------- the close sequence (fakes)

function flowRig(fin: SelfFinish | (() => Promise<SelfFinish>)) {
  const log: string[] = [];
  const files = new Map<string, string>();
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => (log.push("sync"), { text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: (t) => void log.push(`notify:${t}`),
    trace: (r) => void log.push(`trace:${r.decision}`),
    markCause: () => undefined,
    writeStub: (f, t) => void (files.set(f, t), log.push("stub")),
    exists: (f) => files.has(f),
    setTimer: () => () => undefined,
    markClosed: () => void log.push("markClosed"),
    report: async () => (log.push("report"), null),
    selfFinish: async () => (log.push("selfFinish"), typeof fin === "function" ? fin() : fin),
    appendResult: (f, t) => void files.set(f, (files.get(f) ?? "") + t),
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  return { log, files, flow: new CloseFlow(deps), ctx };
}

const FILE = "/h/20261102-120000-demo/result.md";
const merged = { source: "pr-merged" as const, file: FILE, shown: FILE, prompt: prMergedPrompt(FILE, 7), pr: { n: 7, parent: "parent-1", label: "demo" } };

async function drive(r: ReturnType<typeof flowRig>) {
  r.flow.request(merged, r.ctx);
  r.flow.onInput(prMergedPrompt(FILE, 7), "extension");
  r.flow.onModelReply("stop");
  await r.flow.onSettled(r.ctx);
}

test("pr-merged: the close prompt asks for the PR number, the merge commit and what is left open", () => {
  const p = prMergedPrompt(FILE, 7);
  assert.match(p, /PR #7 was merged/);
  assert.ok(p.includes(FILE));
  assert.match(p, /merge commit/);
  assert.match(p, /left open/);
});

test("pr-merged: result.md, the parent report (merged, closing + Result from), then the cleanup spawn, then shutdown", async () => {
  const r = flowRig({ lines: ["cleanup: ok"], spawn: () => void r.log.push("spawn") });
  r.files.set(FILE, "written by the model");
  await drive(r);
  const seq = r.log.filter((l) => /^(prompt|sync|report|markClosed|selfFinish|reply|spawn|shutdown)/.test(l));
  assert.deepEqual(seq, [`prompt:${prMergedPrompt(FILE, 7)}`, "sync", "report", "markClosed", "selfFinish", "reply:parent-1:PR #7 merged, closing", `reply:parent-1:Result from demo: ${FILE}`, "spawn", "shutdown"]);
  assert.match(r.files.get(FILE)!, /## Merge cleanup\n\ncleanup: ok/);
  assert.ok(r.log.includes("trace:cleanup"));
});

test("pr-merged: a refused precondition lands in result.md and the parent report; no spawn", async () => {
  const r = flowRig({ lines: ["cleanup: not started (worktree_dirty); the worktree and branch feat stay"] });
  r.files.set(FILE, "x");
  await drive(r);
  assert.ok(r.log.some((l) => l === "reply:parent-1:PR #7 merged, closing (cleanup: not started (worktree_dirty); the worktree and branch feat stay)"));
  assert.match(r.files.get(FILE)!, /worktree_dirty/);
  assert.ok(r.log.includes("trace:no-cleanup") && !r.log.includes("spawn"));
  assert.equal(r.log.at(-1), "shutdown");
});

test("pr-merged: a self-finish that throws is a refusal line, not a failed close", async () => {
  const r = flowRig(async () => { throw new Error("python missing"); });
  r.files.set(FILE, "x");
  await drive(r);
  assert.ok(r.log.some((l) => l.includes("cleanup: not started (python missing)")));
  assert.equal(r.log.at(-1), "shutdown");
});

test("pr-merged: a PR closed unmerged starts no close and no cleanup", async () => {
  const merged: unknown[] = [];
  const timers: Timers = { set: () => 0, clear: () => undefined };
  const w = new PrWatches({
    poll: async () => ({ snap: openSnap("closed") }),
    send: () => undefined,
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers: { set: (fn) => (setImmediate(fn), 0), clear: timers.clear },
    child: () => true,
    onMerged: (i) => void merged.push(i),
  });
  w.start(K, openSnap());
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(w.has(K), false, "the watch ended");
  assert.deepEqual(merged, []);
});

// ---------------------------------------------------------------- verifyMerged and the spawn (fakes)

const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result });

test("verifyMerged: MERGED, head ref == branch and headRefOid == local tip, each one required", async () => {
  const ok = { state: "merged", headRefName: "feat", headSha: "t1" };
  assert.deepEqual(await verifyMerged(async () => ran(ok), 7, "feat", "t1"), { sha: "t1" });
  for (const bad of [{ ...ok, state: "open" }, { ...ok, state: "closed" }, { ...ok, headRefName: "other" }, { ...ok, headSha: "t2" }]) assert.ok("why" in (await verifyMerged(async () => ran(bad), 7, "feat", "t1")), JSON.stringify(bad));
  assert.ok("why" in (await verifyMerged(async () => ({ kind: "error", message: "x" }), 7, "feat", "t1")));
});

test("spawnDetached: detached, no stdio, unref'd, outside the worktree", () => {
  const seen: { cmd: string; args: string[]; opts: Record<string, unknown>; unref: number } = { cmd: "", args: [], opts: {}, unref: 0 };
  const fake = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    Object.assign(seen, { cmd, args, opts });
    return { on: () => undefined, unref: () => void seen.unref++ };
  }) as unknown as typeof spawn;
  spawnDetached("py", ["a", "b"], "/h", fake);
  assert.equal(seen.cmd, "py");
  assert.deepEqual(seen.args, ["a", "b"]);
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.opts.stdio, "ignore");
  assert.equal(seen.opts.cwd, "/h");
  assert.equal(seen.unref, 1);
});

function fakeDeps(over: Partial<SelfFinishDeps> & { script?: (args: string[]) => string } = {}): SelfFinishDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    cwd: "/w/wt", handoff: "/h/demo", sessionId: "s1", stateDir: "/st", pid: 4242, trusted: false,
    status: async () => ran({ state: "merged", headRefName: "feat", headSha: "t1" }),
    git: async (a) => (a[0] === "symbolic-ref" ? "feat" : "t1"),
    closeScript: async (a) => (over.script ? over.script(a) : JSON.stringify({ ok: true, archived: 3, remoteBranch: null })),
    spawnCleanup: (a) => void spawned.push(a),
    ...over,
    spawned,
  };
}

test("selfFinish: a still-existing remote head branch is listed as kept; the cleanup args carry the fact and the pid", async () => {
  const d = fakeDeps({ closeScript: async () => JSON.stringify({ ok: true, archived: 3, remoteBranch: "origin/feat" }) });
  const r = await selfFinish(d, 7);
  assert.ok(r.lines.includes("kept: remote branch feat (enable delete head branch on merge)"));
  assert.ok(r.lines.some((l) => l.startsWith("workflow archive: ")));
  r.spawn!();
  const a = d.spawned[0];
  assert.deepEqual(a.slice(0, 3), ["selfclean", "--ws", "/w/wt"]);
  assert.equal(a[a.indexOf("--verified-merged") + 1], "t1");
  assert.equal(a[a.indexOf("--wait-pid") + 1], "4242");
  assert.ok(a.includes("--exempt-workflow") && !a.includes("--archive"));
  assert.equal(a[a.indexOf("--out") + 1], path.join("/h/demo", "cleanup.json"));
});

test("selfFinish: a refusal (dirty worktree) gives the reason and no spawn; an unverified PR passes no fact", async () => {
  const d = fakeDeps({ closeScript: async () => JSON.stringify({ ok: false, reason: "worktree_dirty" }) });
  const r = await selfFinish(d, 7);
  assert.equal(r.spawn, undefined);
  assert.ok(r.lines.some((l) => l.includes("worktree_dirty")));
  const seen: string[][] = [];
  const u = fakeDeps({ status: async () => ran({ state: "merged", headRefName: "feat", headSha: "other" }), script: (a) => (seen.push(a), JSON.stringify({ ok: true })) });
  const r2 = await selfFinish(u, 7);
  assert.ok(!seen[0].includes("--verified-merged"));
  assert.ok(r2.lines.some((l) => l.startsWith("merged fact: not verified")));
});

// ---------------------------------------------------------------- integration on a temp repo (real python and git)

// the harness env injects git config (GIT_CONFIG_*) that makes every push fail; the temp repos push to a local bare repo
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG_")));
const run = (cmd: string, args: string[], cwd: string): string => execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const git = (cwd: string, ...args: string[]): string => run("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], cwd);
const py = (args: string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => execFile(PY, ["-E", "-s", SCRIPT, ...args], { encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: os.devNull } }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout) })));

function world() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-selffinish-")));
  const state = path.join(root, "agent", "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  const origin = path.join(root, "origin.git");
  run("git", ["init", "-q", "--bare", "-b", "main", origin], root);
  const repo = path.join(root, "repo");
  run("git", ["clone", "-q", origin, repo], root);
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".workflow/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  const wt = path.join(root, "repo.worktrees", "feat");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  fs.writeFileSync(path.join(wt, "f.txt"), "feature\n");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-q", "-m", "feature");
  const tip = git(wt, "rev-parse", "HEAD");
  // squash merge: main gets the content as a new commit; the branch tip is not an ancestor of main
  git(repo, "merge", "--squash", "feat");
  git(repo, "commit", "-q", "-m", "feature (squash)");
  git(repo, "push", "-q", "origin", "main");
  fs.mkdirSync(path.join(wt, ".workflow", "scratch"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".workflow", "LEDGER-x.md"), "# ledger\n- [x] 1. done\n");
  fs.writeFileSync(path.join(wt, ".workflow", "scratch", "plan.md"), "plan\n");
  const handoff = path.join(root, "handoffs", "20261102-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  const base = ["selfclean", "--ws", wt, "--branch", "feat", "--state", state, "--session", "child-1"];
  return { root, state, repo, wt, tip, handoff, base, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("selfclean: a squash-merged branch is refused without the verified-merged fact and ok with it (while the tip still matches)", async () => {
  const w = world();
  try {
    const plain = await py([...w.base, "--archive", path.join(w.handoff, "workflow")]);
    assert.equal(plain.code, 3);
    assert.equal(JSON.parse(plain.out).reason, "not_merged");
    const stale = await py([...w.base, "--verified-merged", "0".repeat(40), "--archive", path.join(w.handoff, "workflow")]);
    assert.equal(JSON.parse(stale.out).reason, "verified_merged_stale");
    const ok = await py([...w.base, "--verified-merged", w.tip, "--archive", path.join(w.handoff, "workflow")]);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(JSON.parse(ok.out).ok, true);
  } finally {
    w.cleanup();
  }
});

test("selfclean: .workflow/ is archived into the handoff dir and only then exempt from ignored_files; other preconditions stay", async () => {
  const w = world();
  try {
    const archive = path.join(w.handoff, "workflow");
    const noArchive = await py([...w.base, "--verified-merged", w.tip]);
    assert.equal(JSON.parse(noArchive.out).reason, "ignored_files", "without the archive the ignored .workflow/ counts");
    const ok = await py([...w.base, "--verified-merged", w.tip, "--archive", archive]);
    assert.equal(JSON.parse(ok.out).ok, true, ok.out);
    assert.equal(fs.readFileSync(path.join(archive, "LEDGER-x.md"), "utf8"), "# ledger\n- [x] 1. done\n");
    assert.equal(fs.readFileSync(path.join(archive, "scratch", "plan.md"), "utf8"), "plan\n");
    fs.appendFileSync(path.join(w.wt, "f.txt"), "dirty\n");
    const dirty = await py([...w.base, "--verified-merged", w.tip, "--archive", archive]);
    assert.equal(dirty.code, 3);
    assert.equal(JSON.parse(dirty.out).reason, "worktree_dirty");
    git(w.wt, "checkout", "--", "f.txt");
    git(w.repo, "stash", "list");
    fs.writeFileSync(path.join(w.wt, "other.txt"), "z\n");
    git(w.wt, "stash", "push", "-u", "-q", "-m", "wip");
    const stash = await py([...w.base, "--verified-merged", w.tip, "--archive", archive]);
    assert.equal(JSON.parse(stash.out).reason, "stash_references_branch");
  } finally {
    w.cleanup();
  }
});

test("selfclean: a remote head branch that still exists is reported by the check", async () => {
  const w = world();
  try {
    git(w.wt, "push", "-q", "origin", "feat");
    const ok = await py([...w.base, "--verified-merged", w.tip, "--archive", path.join(w.handoff, "workflow")]);
    assert.equal(JSON.parse(ok.out).remoteBranch, "origin/feat");
  } finally {
    w.cleanup();
  }
});

test("detached cleanup: worktree and local branch are gone after the (fake) pi pid exits; cleanup.json says removed; the squash branch needs -D", async () => {
  const w = world();
  try {
    const archive = path.join(w.handoff, "workflow");
    const chk = await py([...w.base, "--verified-merged", w.tip, "--archive", archive]);
    assert.equal(JSON.parse(chk.out).ok, true, chk.out);
    const fakePi = spawn(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { stdio: "ignore" });
    const exited = new Promise((res) => fakePi.on("exit", res));
    const out = path.join(w.handoff, "cleanup.json");
    spawnDetached(PY, ["-E", "-s", SCRIPT, ...w.base, "--verified-merged", w.tip, "--exempt-workflow", "--wait-pid", String(fakePi.pid), "--out", out], w.handoff);
    await new Promise((res) => setTimeout(res, 400));
    assert.ok(fs.existsSync(w.wt), "still there while the pi process runs");
    assert.ok(!fs.existsSync(out));
    await exited;
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 100));
    const res = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(res.status, "removed", JSON.stringify(res));
    assert.equal(res.branchDeleted, true);
    assert.ok(!fs.existsSync(w.wt));
    assert.equal(git(w.repo, "branch", "--list", "feat"), "");
    assert.ok(fs.existsSync(path.join(archive, "LEDGER-x.md")), "the archive survives the removal");
  } finally {
    w.cleanup();
  }
});

test("detached cleanup: a precondition that fails after the exit is written to cleanup.json and nothing is removed", async () => {
  const w = world();
  try {
    const out = path.join(w.handoff, "cleanup.json");
    fs.writeFileSync(path.join(w.wt, "late.txt"), "late\n"); // untracked: dirty by the time the pi process is gone
    const r = await py([...w.base, "--verified-merged", w.tip, "--exempt-workflow", "--wait-pid", "99999999", "--out", out]);
    assert.equal(r.code, 3);
    const res = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual([res.status, res.reason], ["failed", "worktree_dirty"]);
    assert.ok(fs.existsSync(w.wt));
    assert.notEqual(git(w.repo, "branch", "--list", "feat"), "");
  } finally {
    w.cleanup();
  }
});

test("selfFinish end to end: real checks on the temp repo, the spawn starts only when every precondition holds", async () => {
  const w = world();
  try {
    const mk = (): SelfFinishDeps => ({
      cwd: w.wt, handoff: w.handoff, sessionId: "child-1", stateDir: w.state, pid: 99999999, trusted: false,
      status: async () => ran({ state: "merged", headRefName: "feat", headSha: w.tip }),
      git: async (a) => git(w.wt, ...a),
      closeScript: async (a) => (await py(a)).out,
      spawnCleanup: () => undefined,
    });
    const good = await selfFinish(mk(), 7);
    assert.ok(good.spawn, good.lines.join("\n"));
    assert.ok(good.lines.some((l) => l.startsWith("workflow archive:")));
    fs.writeFileSync(path.join(w.wt, "dirty.txt"), "d\n");
    const bad = await selfFinish(mk(), 7);
    assert.equal(bad.spawn, undefined);
    assert.ok(bad.lines.some((l) => l.includes("worktree_dirty")));
    const unverified = await selfFinish({ ...mk(), status: async () => ran({ state: "merged", headRefName: "feat", headSha: "deadbeef" }) }, 7);
    assert.equal(unverified.spawn, undefined, "squash merge without the fact: not_merged (or dirty) refuses");
  } finally {
    w.cleanup();
  }
});
