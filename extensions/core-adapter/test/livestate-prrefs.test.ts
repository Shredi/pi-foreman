import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import { PrWatches } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

const readLive = (waits: unknown[]) => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "rdl-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rdl-"));
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd, mode: "rpc", env: {} }, () => [], undefined, () => waits as never);
  assert.ok(l);
  l.flush();
  return JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8"));
};

test("live file: the pr_watch entry carries prRefs (number, repository, host) beside prs, only when given", () => {
  const read = readLive([
    { id: "pr_watch", kind: "pr", note: "1 pr watch", ageSeconds: 0, leftSeconds: 0, prs: [5], prRefs: [{ n: 5, repo: "owner/repo-b", host: "github.com" }, { n: "x", repo: "owner/repo-b", host: "" }, { n: 6, repo: "", host: "" }] },
    { id: "w2", kind: "pr", note: "1 pr watch", ageSeconds: 0, leftSeconds: 0, prs: [3] },
  ]);
  assert.deepEqual(read.waits[0].prs, [5]);
  assert.deepEqual(read.waits[0].prRefs, [{ n: 5, repo: "owner/repo-b", host: "github.com" }]);
  assert.equal("prRefs" in read.waits[1], false);
});

test("PrWatches.list() keeps the repository and host of each watch key (what the live writer exports as prRefs)", () => {
  const key: PrKey = { host: "github.com", repo: "owner/repo-b", n: 5 };
  const watches = new PrWatches({
    storeEntry: () => ({ kind: "down" }),
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => 0,
    timers: { set: () => 1, clear: () => {} },
  });
  watches.startPending(key);
  const [w] = watches.list();
  assert.deepEqual({ n: w.n, repo: w.key.repo, host: w.key.host }, { n: 5, repo: "owner/repo-b", host: "github.com" });
  watches.clear();
});
