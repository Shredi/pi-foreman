import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";

test("live file: the pr_watch entry carries the unreviewed PRs (number, repository, host) only when given", () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "rdl-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rdl-"));
  const waits = [
    { id: "pr_watch", kind: "pr", note: "2 pr watch", ageSeconds: 0, leftSeconds: 0, prs: [12, 14], unreviewed: [{ n: 12, repo: "acme/app", host: "example.test" }] },
    { id: "w2", kind: "pr", note: "1 pr watch", ageSeconds: 0, leftSeconds: 0, prs: [3] },
  ];
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd, mode: "rpc", env: {} }, () => [], undefined, () => waits);
  assert.ok(l);
  l.flush();
  const read = JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8"));
  assert.deepEqual(read.waits[0].unreviewed, [{ n: 12, repo: "acme/app", host: "example.test" }]);
  assert.equal("unreviewed" in read.waits[1], false);
});
