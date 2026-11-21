// pr_watch's refusal names github.com when it is missing from tools.prGithubHosts; any other unlisted host keeps the plain text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrFollow, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { GithubHosts } from "../prhost.ts";
import type { Spawner } from "../spawn.ts";

const GHE = "ghe.example.test";
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function pwatch(hosts: GithubHosts, at: { host: string; repo: string }) {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async () => {
    throw new Error("no gh call expected");
  };
  const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} }, githubHosts: () => hosts });
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => at };
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {}, tracker, githubHosts: () => hosts };
  const reg = { registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never;
  registerPrFollow(reg, { isChild: false, session: async () => session });
  registerPrPack(reg, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null } as never);
  return tools.get("pr_watch")!.execute("id", { number: 7 }, undefined, undefined, { cwd: process.cwd() });
}

test("pr_watch on a github.com checkout while tools.prGithubHosts lacks github.com says to add it", async () => {
  const r = await pwatch({ hosts: [GHE] }, { host: "github.com", repo: "acme/app" });
  assert.equal(r.isError, true);
  assert.equal(r.details.decision, "host_unsupported");
  assert.equal(r.content[0].text, `pr_watch: github.com is not in tools.prGithubHosts (it lists ${GHE}); add it to watch github.com PRs; nothing was done.`);
});

test("pr_watch on another unlisted host keeps the plain text", async () => {
  const r = await pwatch({ hosts: ["github.com", GHE] }, { host: "other.example.test", repo: "acme/app" });
  assert.equal(r.content[0].text, `pr_watch: only github.com, ${GHE} PRs can be watched (the PR tracker covers github.com, ${GHE}); nothing was done.`);
});
