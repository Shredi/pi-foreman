// D93 (B): pr_status, pr_checks and pr_comments with an explicit repo send `repoless` only from a cwd outside any git checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outsideCheckout, registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";
import { rmTestTmp } from "./_tmpbase.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function setup() {
  const tools = new Map<string, Tool>();
  const reqs: Record<string, unknown>[] = [];
  const spawner: Spawner = async (_c, _a, opt) => {
    reqs.push(JSON.parse(opt.input ?? "{}") as Record<string, unknown>);
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "x" }) + "\n", stderr: "", timedOut: false };
  };
  const watches = new PrWatches({ storeEntry: () => ({ kind: "waiting" }), githubHosts: () => ({ hosts: ["github.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: { prHost: "gh" }, gateOn: false, reviewed: async () => [], watches, trace: () => {}, track: async () => "added", githubHosts: () => ({ hosts: ["github.com"] }) };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const call = async (name: string, params: Record<string, unknown>, cwd: string) => {
    reqs.length = 0;
    await tools.get(name)!.execute("id", params, undefined, undefined, { cwd });
    return reqs[0];
  };
  return { call };
}

test("repoless goes out for the three read tools with repo from a folder outside any checkout", async () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-repoless-")));
  try {
    assert.equal(outsideCheckout(plain), true);
    const x = setup();
    for (const name of ["pr_status", "pr_checks", "pr_comments"]) {
      const withRepo = await x.call(name, { number: 5, repo: "acme/lib" }, plain);
      assert.equal(withRepo.repoless, true, name);
      assert.equal(withRepo.op, name);
      const without = await x.call(name, { number: 5 }, plain);
      assert.equal("repoless" in without, false, `${name} without repo`);
    }
  } finally {
    rmTestTmp(plain);
  }
});

test("inside a checkout the request carries no repoless", async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-repoless-co-")));
  try {
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "sub"));
    assert.equal(outsideCheckout(path.join(repo, "sub")), false);
    const x = setup();
    for (const name of ["pr_status", "pr_checks", "pr_comments"]) {
      const req = await x.call(name, { number: 5, repo: "acme/lib" }, path.join(repo, "sub"));
      assert.equal("repoless" in req, false, name);
    }
  } finally {
    rmTestTmp(repo);
  }
});
