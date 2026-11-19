// The `pr` row of the findings store (findings.ts appendPrRow) is asked for when a PR watch is armed: pr_create and pr_watch, best effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };
type Row = { repo: string; number: number; branch: string | null; head: string | null; cwd: string };

function checkout(branch: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prrow-")));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", branch]);
  return dir;
}

function setup(result: Record<string, unknown>, recordPr?: ((row: Row) => Promise<void>) | null) {
  const tools = new Map<string, Tool>();
  const rows: Row[] = [];
  const traces: Record<string, unknown>[] = [];
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, ...result }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ storeEntry: async () => ({ kind: "down" }), reviewedHeads: () => [], send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const session: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: false, reviewed: async () => [], watches, trace: (r) => void traces.push(r), githubHosts: () => ({ hosts: ["github.com"] }),
    tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) },
    ...(recordPr === null ? {} : { recordPr: recordPr ?? (async (row) => void rows.push(row)) }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const call = async (name: string, params: Record<string, unknown>, cwd: string) => (await tools.get(name)!.execute("id", params, undefined, undefined, { cwd })).content[0].text;
  return { watches, rows, traces, call };
}

const created = { action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" };
const status = { action: "pr_status", number: 9, url: "https://github.com/acme/app/pull/9" };

test("pr_create: the row carries the head argument as branch", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(created);
    await h.call("pr_create", { title: "t", body: "b", head: "feature/x" }, dir);
    assert.deepEqual(h.rows.map(({ cwd: _c, head: _h, ...r }) => r), [{ repo: "acme/app", number: 5, branch: "feature/x" }]);
    assert.equal(h.rows[0].cwd, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pr_create without head: the branch of the checkout, also for pr_create {cwd}", async () => {
  const dir = checkout("current-branch");
  const other = checkout("other-branch");
  try {
    const h = setup(created);
    await h.call("pr_create", { title: "t", body: "b" }, dir);
    assert.equal(h.rows[0].branch, "current-branch");
    const h2 = setup(created);
    await h2.call("pr_create", { title: "t", body: "b", cwd: other }, dir);
    assert.equal(h2.rows[0].branch, "other-branch");
    assert.equal(h2.rows[0].cwd, other);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("a bare pr_watch writes the checkout's branch", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(status);
    await h.call("pr_watch", {}, dir);
    assert.deepEqual(h.rows.map((r) => [r.repo, r.number, r.branch]), [["acme/app", 9, "current-branch"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pr_watch with a number writes a null branch; with repo and number too", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(status);
    await h.call("pr_watch", { number: 9 }, dir);
    await h.call("pr_watch", { number: 12, repo: "acme/other", host: "github.com" }, dir);
    assert.deepEqual(h.rows.map((r) => [r.repo, r.number, r.branch]), [["acme/app", 9, null], ["acme/other", 12, null]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a second pr_watch of the same PR (duplicate) asks for no second row", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(status);
    await h.call("pr_watch", {}, dir);
    await h.call("pr_watch", {}, dir);
    assert.equal(h.rows.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused watch (not tracked host) writes no row", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup({ ...status, url: "https://example.test/acme/app/pull/9" });
    await h.call("pr_watch", { number: 9, repo: "acme/app", host: "example.test" }, dir);
    assert.deepEqual(h.rows, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing row write leaves the watch armed, answers as if it worked and is traced", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(status, async () => {
      throw new Error("locked: s1.jsonl.lock");
    });
    const text = await h.call("pr_watch", {}, dir);
    assert.match(text, /^pr_watch: \{"watching":true,"number":9/);
    assert.deepEqual(h.watches.numbers(), [9]);
    assert.ok(h.traces.some((t) => t.event === "pr_watch" && t.outcome === "pr_row_failed"));
    const h2 = setup(created, async () => {
      throw new Error("disk full");
    });
    const text2 = await h2.call("pr_create", { title: "t", body: "b" }, dir);
    assert.match(text2, /pr_watch: armed/);
    assert.deepEqual(h2.watches.numbers(), [5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a session without recordPr (an older caller) arms the watch as before", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(status, null);
    await h.call("pr_watch", {}, dir);
    assert.deepEqual(h.watches.numbers(), [9]);
    assert.deepEqual(h.rows, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pr_create: a fork-form head owner:branch stores the branch after the first colon", async () => {
  const dir = checkout("current-branch");
  try {
    const h = setup(created);
    await h.call("pr_create", { title: "t", body: "b", head: "someone:feature/x" }, dir);
    assert.equal(h.rows[0].branch, "feature/x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
