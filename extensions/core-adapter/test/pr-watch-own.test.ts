// D179: a pr_watch with an explicit number marks the watch as the session's own (WatchRecord.own); the record keeps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrFollow, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

async function watched(params: Record<string, unknown>) {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async () => {
    throw new Error("no gh call expected");
  };
  const hosts = { hosts: ["github.com"] };
  const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} }, githubHosts: () => hosts });
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) };
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {}, tracker, githubHosts: () => hosts };
  const reg = { registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never;
  registerPrFollow(reg, { isChild: false, session: async () => session });
  registerPrPack(reg, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null } as never);
  const r = await tools.get("pr_watch")!.execute("id", params, undefined, undefined, { cwd: process.cwd() });
  return { r, records: watches.records() };
}

test("pr_watch with a number (with or without repo) records the watch as own", async () => {
  for (const params of [{ number: 7 }, { number: 7, repo: "acme/app" }]) {
    const { r, records } = await watched(params);
    assert.equal(r.details.decision, "watching", r.content[0].text);
    assert.equal(records.length, 1);
    assert.equal(records[0].own, true);
  }
});
