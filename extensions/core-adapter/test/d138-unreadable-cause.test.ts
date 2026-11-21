// D138: the "not compared: start/end unreadable" notice names why the picture was unreadable.
import "./_hermetic-env.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitIn } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { compareRunEnd, noticeText, spawnGit, takeStartEntry, traceLines, type GitRunner, type StartEntry } from "../readonlystate.ts";

let base = "";
let repo = "";
const home = os.homedir();
type Picture = Extract<StartEntry, { kind: "picture" }>;

before(() => {
  base = fs.realpathSync(mkTestTmp("pf-d138-"));
  repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  gitIn(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
});
after(() => rmTestTmp(base));

const hang: GitRunner = (_cwd, _args, sig) => new Promise((_res, rej) => sig.addEventListener("abort", () => rej(new Error("aborted"))));
const failing = (e: object): GitRunner => async () => {
  throw Object.assign(new Error("git"), e);
};
const start = async (root: string, g: GitRunner = spawnGit, ms?: number): Promise<Picture> => (await takeStartEntry([root], home, g, ms)) as Picture;
const text = (r: Awaited<ReturnType<typeof compareRunEnd>>): string => noticeText("reviewer", "run-12345678", r);

test("a start past the deadline: the notice says (deadline)", async () => {
  const s = await start(repo, hang, 100);
  const r = await compareRunEnd(s, home, spawnGit);
  assert.equal(r.reason, "start unreadable");
  assert.equal(r.cause, "deadline");
  assert.match(text(r), /was not compared: start unreadable \(deadline\)/);
});

test("a start in a directory that is no git tree: (not a git tree)", async () => {
  const dir = path.join(base, "plain");
  fs.mkdirSync(dir);
  const r = await compareRunEnd(await start(dir), home, spawnGit);
  assert.equal(r.cause, "not a git tree");
  assert.match(text(r), /start unreadable \(not a git tree\)/);
});

test("a git run that exits non-zero: the exit code is named", async () => {
  const r = await compareRunEnd(await start(repo, failing({ code: 128 })), home, spawnGit);
  assert.equal(r.cause, "git failed, exit 128");
  assert.match(text(r), /start unreadable \(git failed, exit 128\)/);
});

test("a git run killed by its timeout: (git failed, timeout)", async () => {
  const r = await compareRunEnd(await start(repo, failing({ killed: true, signal: "SIGKILL", code: null })), home, spawnGit);
  assert.equal(r.cause, "git failed, timeout");
});

test("an end picture whose git run fails: end unreadable with the cause (its own field, not in the trace lines)", async () => {
  const s = await start(repo);
  const r = await compareRunEnd(s, home, failing({ code: 1 }));
  assert.equal(r.reason, "end unreadable");
  assert.match(text(r), /end unreadable \(git failed, exit 1\)/);
  assert.deepEqual(traceLines(r), ["not compared: end unreadable"], "the trace lines keep their text; the cause is its own field");
});

test("a settings file that cannot be read: (settings file unreadable)", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  if (process.platform === "win32") return t.skip("chmod 000 does not deny reads on Windows");
  const dir = path.join(base, "locked");
  fs.mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  const cfg = path.join(dir, ".git", "config");
  fs.chmodSync(cfg, 0o000);
  try {
    const r = await compareRunEnd(await start(dir), home, spawnGit);
    assert.equal(r.cause, "settings file unreadable");
    assert.match(text(r), /start unreadable \(settings file unreadable\)/);
  } finally {
    fs.chmodSync(cfg, 0o644);
  }
});

test("a start picture aborted by its caller: (aborted)", async () => {
  const { takeReadonlyState } = await import("../readonlystate.ts");
  const ctl = new AbortController();
  let cause = "";
  const p = takeReadonlyState(repo, home, hang, undefined, { signal: ctl.signal, onCause: (c) => (cause = c) });
  setTimeout(() => ctl.abort(), 50);
  assert.equal(await p, "unreadable");
  assert.equal(cause, "aborted");
});

test("a readable pair has no cause", async () => {
  const r = await compareRunEnd(await start(repo), home, spawnGit);
  assert.equal(r.outcome, "unchanged");
  assert.equal(r.cause, undefined);
});
