// D98: with the PR search off or the open-PR feature off, the poll clears the stale search entries of open-prs.json once and says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { line, main, pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { openPrsFile, refreshOpenPrs } from "../openprs.ts";
import type { GhRunner, OpenPrsFile } from "../openprs.ts";
import { clearStoreCache } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const node = (n: number, repo: string) => ({ number: n, title: `PR ${n}`, url: `https://github.com/${repo}/pull/${n}`, isDraft: false, updatedAt: "2026-10-31T10:00:00Z", repository: { nameWithOwner: repo }, author: { login: "octo" }, commits: { nodes: [] } });
const answer = (...nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });

function setup(openPrs: unknown) {
  clearStoreCache();
  const agentDir = mkTestTmp("searchoff-");
  const file = openPrsFile(agentDir);
  const cfg = { value: { radar: { openPrs } } as Record<string, unknown> };
  const clock = { t: 50_000_000 };
  const gh: GhRunner = async () => answer(node(1, "acme/lib"), node(2, "acme/lib"));
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => (clock.t += 400_000),
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: cfg.value, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async () => ({ kind: "ran", result: { prs: [], errors: [], comments: [] } }) as SafeOpOutcome,
    refresh: (config, hosts) => refreshOpenPrs({ file, config, gh, now: deps.now, force: true, ...(hosts ? { hosts } : {}) }),
  };
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as OpenPrsFile;
  return { deps, cfg, file, read, done: () => rmTestTmp(agentDir) };
}

test("search on, then off: the next poll clears the entries once and names it", async () => {
  const h = setup({ mine: true });
  try {
    const first = await pollPrs(h.deps);
    assert.equal(first.searched, true);
    assert.equal(first.cleared, undefined);
    assert.equal(h.read().openPrs.length, 2);
    h.cfg.value = { radar: { openPrs: { mine: false } } };
    const off = await pollPrs(h.deps);
    assert.equal(off.cleared, 2);
    assert.equal(off.searched, false);
    assert.deepEqual(h.read().openPrs, []);
    assert.equal("fetchedAt" in h.read(), false);
    assert.match(h.read().checkedAt ?? "", /^\d{4}-/);
    assert.match(line(off), /search off, cleared 2 entries/);
    const before = fs.statSync(h.file).mtimeMs;
    const again = await pollPrs(h.deps);
    assert.equal(again.cleared, undefined);
    assert.equal(fs.statSync(h.file).mtimeMs, before, "a second poll writes nothing");
    assert.doesNotMatch(line(again), /cleared/);
  } finally {
    h.done();
  }
});

test("search off with an absent or empty file writes nothing", async () => {
  const h = setup({ mine: false });
  try {
    const r = await pollPrs(h.deps);
    assert.equal(r.cleared, undefined);
    assert.equal(fs.existsSync(h.file), false);
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, JSON.stringify({ v: 1, checkedAt: "2026-01-01T00:00:00.000Z", openPrs: [] }));
    const before = fs.statSync(h.file).mtimeMs;
    await pollPrs(h.deps);
    assert.equal(fs.statSync(h.file).mtimeMs, before);
    assert.equal(h.read().checkedAt, "2026-01-01T00:00:00.000Z");
  } finally {
    h.done();
  }
});

test("feature off after a search poll clears the list once", async () => {
  const h = setup({ mine: true });
  try {
    await pollPrs(h.deps);
    assert.equal(h.read().openPrs.length, 2);
    h.cfg.value = { radar: { openPrs: { enabled: false } } };
    const off = await pollPrs(h.deps);
    assert.equal(off.skipped, "off");
    assert.equal(off.cleared, 2);
    assert.deepEqual(h.read().openPrs, []);
    const before = fs.statSync(h.file).mtimeMs;
    const again = await pollPrs(h.deps);
    assert.equal(again.skipped, "off");
    assert.equal(again.cleared, undefined);
    assert.equal(fs.statSync(h.file).mtimeMs, before);
  } finally {
    h.done();
  }
});

test("--json carries cleared only on a clearing poll", async () => {
  const h = setup({ mine: true });
  try {
    await pollPrs(h.deps);
    h.cfg.value = { radar: { openPrs: { mine: false } } };
    const outs: string[] = [];
    assert.equal(await main(["poll", "--json"], (s) => outs.push(s), () => undefined, () => h.deps), 0);
    assert.equal(JSON.parse(outs[0]).cleared, 2);
    await main(["poll", "--json"], (s) => outs.push(s), () => undefined, () => h.deps);
    assert.equal("cleared" in JSON.parse(outs[1]), false);
  } finally {
    h.done();
  }
});
