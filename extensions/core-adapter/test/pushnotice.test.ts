import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PushNotice, chainSegments, parsePush, parsePushOutput } from "../pushnotice.ts";
import type { PushNoticeDeps } from "../pushnotice.ts";
import type { PrOp } from "../gitpack.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";

const seg = (command: string) => chainSegments(command);
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result: { ok: true, ...result } });
const pre = (precondition: string): SafeOpOutcome => ({ kind: "precondition", precondition, message: "m" });
const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

test("chainSegments: a relative second cd resolves against the first, an absolute one replaces it", () => {
  assert.equal(seg("cd a && cd b && git push")[0].cd, "a/b");
  assert.equal(seg("cd a && cd /abs && git push")[0].cd, "/abs");
  assert.equal(seg("cd /abs/ && cd b && git push")[0].cd, "/abs/b");
  assert.equal(seg("cd ~/x && cd b && git push")[0].cdBad, true);
});

test("chainSegments: operators, quotes, redirects, env words and a leading cd", () => {
  const s = seg("cd sub && GH_REPO=acme/x gh pr comment 5 -b 'a && b' 2>&1 | tail -n 3; git status");
  assert.deepEqual(s.map((x) => x.words), [["gh", "pr", "comment", "5", "-b", "a && b"], ["tail", "-n", "3"], ["git", "status"]]);
  assert.equal(s[0].cd, "sub");
  assert.equal(s[0].env.GH_REPO, "acme/x");
  assert.equal(seg("git push")[0].cd, null);
  assert.equal(seg("cd ~/x && git push")[0].cdBad, true);
  assert.equal(seg("cd $DIR && git push")[0].cdBad, true);
  assert.deepEqual(seg("echo a\ngit push origin feat").map((x) => x.words[0]), ["echo", "git"]);
});

test("parsePush: global options, remote, git stash push is not a push", () => {
  assert.deepEqual(parsePush(["git", "push"]), { remote: null, dirs: [], gitDir: false });
  assert.deepEqual(parsePush(["git", "-C", "x", "push", "-u", "up", "feat"]), { remote: "up", dirs: ["x"], gitDir: false });
  assert.deepEqual(parsePush(["git", "-c", "a=b", "--no-pager", "push", "--force-with-lease", "origin"]), { remote: "origin", dirs: [], gitDir: false });
  assert.equal(parsePush(["git", "--git-dir=x", "push"])?.gitDir, true);
  assert.equal(parsePush(["git", "stash", "push"]), null);
  assert.equal(parsePush(["git", "status"]), null);
  assert.equal(parsePush(["gh", "pr", "push"]), null);
});

test("parsePushOutput: new branch, fast-forward, forced, refs/heads prefix; tags, deletions, rejections and up-to-date skipped", () => {
  const out = [
    "To github.com:acme/app.git",
    " * [new branch]      feat -> feat",
    "   1a2b3c4..5d6e7f8  topic -> topic",
    " + 1a2b3c4...5d6e7f8 forced -> forced (forced update)",
    " * [new branch]      HEAD -> refs/heads/other",
    " * [new tag]         v1 -> v1",
    " - [deleted]         gone",
    " ! [rejected]        stale -> stale (non-fast-forward)",
    " ! [remote rejected] hook -> hook (pre-receive hook declined)",
    " = [up to date]      same -> same",
  ].join("\n");
  assert.deepEqual(parsePushOutput(out), ["feat", "topic", "forced", "other"]);
  assert.deepEqual(parsePushOutput("Everything up-to-date"), []);
});

interface Call {
  op: PrOp;
  args: Record<string, unknown>;
  cwd?: string;
}

function rig(opts: { merged?: boolean | null; find?: (c: Call) => SafeOpOutcome | Promise<SafeOpOutcome> | undefined; enabled?: boolean; baseBranch?: string | null; quietBranch?: string } = {}) {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const asked: string[] = [];
  const notes: string[] = [];
  const deps: PushNoticeDeps = {
    enabled: () => opts.enabled ?? true,
    run: async (op, args, cwd) => {
      const c = { op, args, cwd };
      calls.push(c);
      return (await opts.find?.(c)) ?? ran({ prs: [] });
    },
    now: () => clock,
    quietBranch: async () => opts.quietBranch ?? "",
    baseBranch: () => (opts.baseBranch === undefined ? "main" : opts.baseBranch),
    merged: async (cwd, remote, name) => (asked.push(`${cwd}|${remote}|${name}`), opts.merged === undefined ? false : opts.merged),
  };
  const d = new PushNotice(deps);
  return { d, calls, asked, notes, advance: (ms: number) => void (clock += ms), run: () => d.run((b) => void notes.push(b)), finds: () => calls.filter((c) => c.op === "pr_find") };
}

const push = (h: ReturnType<typeof rig>, name: string, cwd = "/w") => h.d.onBash(`git push origin ${name}`, ` * [new branch]      ${name} -> ${name}`, true, cwd);

test("onBash: git push records the branch with cwd and remote; -C and cd record the other cwd; failures and stash push do not", async () => {
  const h = rig();
  await h.d.onBash("git push -u origin feat", " * [new branch]      feat -> feat", true, "/w");
  await h.d.onBash("git -C /other push up topic", "   1a2b3c4..5d6e7f8  topic -> topic", true, "/w");
  await h.d.onBash("cd sub && git push", " * [new branch]      sub -> sub", true, "/w");
  await h.d.onBash("git stash push", "Saved working directory", true, "/w");
  await h.d.onBash("git push origin gone", " * [new branch]      gone -> gone", false, "/w");
  assert.deepEqual(h.d.pushedBranches().map((x) => ({ name: x.name, cwd: x.cwd, remote: x.remote })), [
    { name: "sub", cwd: path.resolve("/w/sub"), remote: "origin" },
    { name: "topic", cwd: path.resolve("/other"), remote: "up" },
    { name: "feat", cwd: "/w", remote: "origin" },
  ]);
});

test("onBash: a quiet push falls back to the checkout's branch, but not with -C or cd; a disabled notice records nothing", async () => {
  const h = rig({ quietBranch: "quiet" });
  await h.d.onBash("git push", "", true, "/w");
  await h.d.onBash("git -C /o push", "", true, "/w");
  await h.d.onBash("cd /o && git push", "", true, "/w");
  assert.deepEqual(h.d.pushedBranches().map((x) => x.name), ["quiet"]);
  const off = rig({ enabled: false });
  await push(off, "feat");
  assert.deepEqual(off.d.pushedBranches(), []);
});

test("onBash: the pushed-branch memory holds eight, newest first", async () => {
  const h = rig();
  for (let i = 0; i < 10; i++) await h.d.onBash("git push origin b" + i, ` * [new branch]      b${i} -> b${i}`, true, "/w");
  assert.deepEqual(h.d.pushedBranches().map((x) => x.name), ["b9", "b8", "b7", "b6", "b5", "b4", "b3", "b2"]);
});

test("notice: a pushed branch with no PR of any state and not merged is named once", async () => {
  const n = rig();
  await push(n, "feat");
  await n.run();
  assert.deepEqual(n.notes, ["feat"]);
  assert.deepEqual(n.finds().map((c) => [c.args.head, c.args.state]), [["feat", "all"]]);
  assert.deepEqual(n.asked, ["/w|origin|feat"]);
  n.advance(11 * 60_000);
  await n.run();
  assert.deepEqual(n.notes, ["feat"], "once per branch");
});

test("notice: the push -u case", async () => {
  const n = rig();
  await n.d.onBash("git push -u origin feat", "branch 'feat' set up to track 'origin/feat'.\n * [new branch]      feat -> feat", true, "/w");
  await n.run();
  assert.deepEqual(n.notes, ["feat"]);
});

test("notice: no notice for the base branch, a branch with a PR of any state, or a merged branch", async () => {
  const base = rig();
  await push(base, "main");
  await base.run();
  assert.deepEqual(base.notes, []);
  assert.equal(base.finds().length, 0);

  const open = rig({ find: () => ran({ prs: [{ number: 4, url: url("acme/app", 4), state: "open", headRefName: "feat" }] }) });
  await push(open, "feat");
  await open.run();
  assert.deepEqual(open.notes, [], "pr_find found the open PR");

  const other = rig({ find: () => ran({ prs: [{ number: 4, url: url("acme/app", 4), state: "open", headRefName: "elsewhere" }] }) });
  await push(other, "feat");
  await other.run();
  assert.deepEqual(other.notes, ["feat"], "a PR of another head branch does not count");

  const squash = rig({ find: () => ran({ prs: [{ number: 5, url: url("acme/app", 5), state: "merged", headRefName: "feat" }] }) });
  await push(squash, "feat");
  await squash.run();
  assert.deepEqual(squash.notes, []);
  assert.deepEqual(squash.asked, [], "the merged subcommand is not needed");

  const merged = rig({ merged: true });
  await push(merged, "feat");
  await merged.run();
  assert.deepEqual(merged.notes, []);

  const unknown = rig({ merged: null });
  await push(unknown, "feat");
  await unknown.run();
  assert.deepEqual(unknown.notes, [], "no ref: skipped");
});

test("notice: a failed lookup is retried after ten minutes, not before; a second call during a run is dropped", async () => {
  let fail = true;
  const n = rig({ find: () => (fail ? pre("pr_host_failed") : ran({ prs: [] })) });
  await push(n, "feat");
  await n.run();
  assert.deepEqual(n.notes, []);
  n.advance(5 * 60_000);
  await n.run();
  assert.equal(n.finds().length, 1, "within ten minutes");
  fail = false;
  n.advance(6 * 60_000);
  await n.run();
  assert.deepEqual(n.notes, ["feat"]);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const slow = rig({ find: () => gate.then(() => ran({ prs: [] })) });
  await push(slow, "feat");
  const first = slow.d.run((b) => void slow.notes.push(b));
  const second = slow.d.run((b) => void slow.notes.push(b + "!"));
  await second;
  release();
  await first;
  assert.deepEqual(slow.notes, ["feat"]);
});

test("notice: git -C other push and cd other && git push record the other cwd for the lookup", async () => {
  const n = rig();
  await n.d.onBash("git -C /other push origin a", " * [new branch]      a -> a", true, "/w");
  await n.d.onBash("cd /second && git push origin b", " * [new branch]      b -> b", true, "/w");
  await n.run();
  assert.deepEqual(n.finds().map((c) => c.cwd).sort(), [path.resolve("/other"), path.resolve("/second")]);
  assert.deepEqual(n.notes.sort(), ["a", "b"]);
});

test("notice: CloseFlow starts the evaluation without waiting for it", () => {
  const log: string[] = [];
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => void log.push("prompt"),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: () => undefined,
    notify: () => void log.push("notify"),
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => false,
    setTimer: () => () => undefined,
    pushNotice: () => void log.push("notice-started"),
  };
  const flow = new CloseFlow(deps);
  flow.request({ source: "herdr", file: "/x/r.md" }, { isIdle: () => true });
  assert.ok(log.includes("notice-started"));
  assert.ok(log.includes("prompt"), "the close turn starts at once");
  assert.ok(log.indexOf("notice-started") < log.indexOf("prompt"));
  const refused = new CloseFlow({ ...deps, activeRuns: () => 1 });
  log.length = 0;
  refused.request({ source: "herdr", file: "/x/r.md" }, { isIdle: () => true });
  assert.ok(!log.includes("notice-started"), "a refused close starts nothing");
});
