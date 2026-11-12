import { test } from "node:test";
import assert from "node:assert/strict";
import { prWatchWait } from "../livestate.ts";

const key = (repo: string) => ({ host: "github.com", repo });

test("prWatchWait: no watch gives no wait", () => {
  assert.equal(prWatchWait([], []), null);
});

test("prWatchWait: the live writer's pr_watch wait carries prs and prRefs with repository and host", () => {
  const w = prWatchWait([{ n: 5, key: key("owner/repo-b") }, { n: 7, key: key("owner/repo-a") }], []);
  assert.deepEqual(w?.prs, [5, 7]);
  assert.deepEqual(w?.prRefs, [{ n: 5, repo: "owner/repo-b", host: "github.com" }, { n: 7, repo: "owner/repo-a", host: "github.com" }]);
  assert.equal(w && "unreviewed" in w, false);
});

test("prWatchWait: unreviewed is added only when present", () => {
  const w = prWatchWait([{ n: 5, key: key("owner/repo-b") }], [{ n: 5, repo: "owner/repo-b", host: "github.com" }]);
  assert.deepEqual(w?.unreviewed, [{ n: 5, repo: "owner/repo-b", host: "github.com" }]);
});
