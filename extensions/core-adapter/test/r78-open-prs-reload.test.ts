// D112: the open-PR refresher reloads the merged config when the user or overlay layer changed on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OpenPrsRefresher, ReloadingConfig, configFingerprint, openPrsFile } from "../openprs.ts";
import type { GhRunner } from "../openprs.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const answer = JSON.stringify({ data: { search: { nodes: [] } } });
const bump = (file: string, ms: number) => {
  const t = new Date(Date.now() + ms);
  fs.utimesSync(file, t, t);
};

/** A rig whose "loader" reads the user file the way the merged config would. */
function rig() {
  const dir = mkTestTmp("r78r-");
  const user = path.join(dir, "foreman.json");
  const write = (v: unknown, skew = 0) => {
    fs.writeFileSync(user, JSON.stringify(v));
    bump(user, skew);
  };
  write({ radar: { openPrs: { enabled: true } } });
  const read = () => ({ config: JSON.parse(fs.readFileSync(user, "utf8")) as Record<string, unknown> });
  const loads = { n: 0 };
  const cfg = new ReloadingConfig(dir, read(), async () => (loads.n++, read()));
  const queries: string[] = [];
  const gh: GhRunner = async (args) => {
    queries.push(args.find((a) => a.startsWith("q="))!.slice(2));
    return answer;
  };
  const clock = { t: 1_000_000_000_000 };
  const rf = new OpenPrsRefresher({
    agentDir: dir,
    prepare: () => cfg.refresh(),
    config: () => (cfg.current().config.radar as { openPrs: unknown }).openPrs,
    gh,
    now: () => (clock.t += 10 * 60_000),
  });
  return { dir, write, loads, queries, rf, done: () => rmTestTmp(dir) };
}

test("unchanged config files cause no reload", async () => {
  const r = rig();
  await r.rf.tick();
  await r.rf.tick();
  assert.equal(r.loads.n, 0);
  r.done();
});

test("a user config change after start is used by the next tick", async () => {
  const r = rig();
  assert.equal(await r.rf.tick(), "refreshed");
  const first = r.queries.length;
  assert.equal(first, 2);
  r.write({ radar: { openPrs: { enabled: true, mine: false, authors: ["octo"], scope: ["acme"] } } }, 5000);
  assert.equal(await r.rf.tick(), "refreshed");
  assert.equal(r.loads.n, 1);
  assert.ok(r.queries.slice(first).every((q) => q === "is:pr is:open author:octo org:acme"), r.queries.join("|"));
  await r.rf.tick();
  assert.equal(r.loads.n, 1, "one reload per change");
  r.done();
});

test("the overlay layer is part of the fingerprint: a package config added, changed or removed", () => {
  const dir = mkTestTmp("r78r-");
  const pkg = path.join(dir, "npm", "node_modules", "@acme", "cfg");
  fs.mkdirSync(pkg, { recursive: true });
  const base = configFingerprint(dir);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@acme/cfg", pi: { foreman: { config: "foreman.json" } } }));
  const withPkg = configFingerprint(dir);
  assert.notEqual(withPkg, base);
  fs.writeFileSync(path.join(pkg, "foreman.json"), "{}");
  const withCfg = configFingerprint(dir);
  assert.notEqual(withCfg, withPkg);
  fs.writeFileSync(path.join(pkg, "foreman.json"), '{"radar":{}}');
  bump(path.join(pkg, "foreman.json"), 5000);
  assert.notEqual(configFingerprint(dir), withCfg);
  fs.rmSync(path.join(pkg, "foreman.json"));
  assert.notEqual(configFingerprint(dir), withCfg);
  assert.equal(configFingerprint(dir), configFingerprint(dir));
  rmTestTmp(dir);
});

test("a failed reload keeps the old config and retries at the next call", async () => {
  const r = rig();
  let fail = true;
  const cfg = new ReloadingConfig(r.dir, { v: 1 }, async () => {
    if (fail) throw new Error("boom");
    return { v: 2 };
  });
  r.write({ changed: true }, 5000);
  await cfg.refresh();
  assert.equal(cfg.current().v, 1);
  fail = false;
  await cfg.refresh();
  assert.equal(cfg.current().v, 2);
  r.done();
});

test("a defaults result (loader fallback) keeps the old config and retries at the next tick", async () => {
  const r = rig();
  let source: "defaults" | "cli" = "defaults";
  let calls = 0;
  const cfg = new ReloadingConfig(r.dir, { v: 1, source: "cli" as string }, async () => (calls++, { v: 2, source }), (c) => c.source === "cli");
  r.write({ changed: true }, 5000);
  await cfg.refresh();
  assert.equal(cfg.current().v, 1);
  await cfg.refresh();
  assert.equal(calls, 2, "retried without a further file edit");
  assert.equal(cfg.current().v, 1);
  source = "cli";
  await cfg.refresh();
  assert.equal(cfg.current().v, 2);
  await cfg.refresh();
  assert.equal(calls, 3, "fingerprint stored after the cli result");
  r.done();
});
