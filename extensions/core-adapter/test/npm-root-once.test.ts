// The global npm root is looked up by two lookups that share one `npm root -g` answer per process (owned.ts npmRootOnce, pi-model-data.mjs): these tests clear the
// process-wide slot that _hermetic-env.mjs seeds and run a stub `npm` (a real executable on a temp PATH) that logs each start.
// POSIX only, like the fake gh: Node cannot exec a .cmd stub without a shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { npmRootOnce } from "../owned.ts";
import { piModelDataDir } from "../pi-model-data.mjs";
import { defaultSpawner } from "../spawn.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "the stub npm is a shell script" : false;
const KEY = Symbol.for("pi-foreman.npm-root");

/** Runs `fn` with an empty npm-root slot and a stub `npm` first on PATH that prints `root` (or fails when null); returns the stub's start count. */
async function withStubNpm(root: string | null, fn: () => Promise<void> | void): Promise<number> {
  const dir = mkTestTmp("pf-npm-once-");
  const log = path.join(dir, "starts.log");
  const stubDir = path.join(dir, "bin");
  fs.mkdirSync(stubDir);
  fs.writeFileSync(log, "");
  const body = root === null ? "exit 1" : `printf '%s\\n' '${root}'`;
  fs.writeFileSync(path.join(stubDir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  const g = globalThis as Record<symbol, unknown>;
  const saved = { slot: g[KEY], path: process.env.PATH, exempt: process.env.FOREMAN_SPAWN_GUARD_EXEMPT, ai: process.env.PI_FOREMAN_PI_AI_DATA, bin: process.env.PI_FOREMAN_PI_BIN };
  try {
    g[KEY] = undefined;
    process.env.PATH = stubDir;
    process.env.FOREMAN_SPAWN_GUARD_EXEMPT = "1";
    delete process.env.PI_FOREMAN_PI_AI_DATA;
    delete process.env.PI_FOREMAN_PI_BIN;
    await fn();
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  } finally {
    g[KEY] = saved.slot;
    process.env.PATH = saved.path;
    for (const [k, v] of [["FOREMAN_SPAWN_GUARD_EXEMPT", saved.exempt], ["PI_FOREMAN_PI_AI_DATA", saved.ai], ["PI_FOREMAN_PI_BIN", saved.bin]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmTestTmp(dir);
  }
}

const input = (env: Record<string, string | undefined> = {}) => ({ spawn: defaultSpawner, env, platform: process.platform, execPath: process.execPath });

test("two lookups in one process start npm once and share the answer", { skip }, async () => {
  const root = path.resolve(path.sep, "stub", "global", "node_modules");
  let answers: (string | null)[] = [];
  const starts = await withStubNpm(root, async () => {
    answers = [await npmRootOnce(input()), await npmRootOnce(input())];
  });
  assert.deepEqual(answers, [root, root]);
  assert.equal(starts, 1);
});

test("concurrent lookups share one promise and one npm start", { skip }, async () => {
  const root = path.resolve(path.sep, "stub", "global", "node_modules");
  let answers: (string | null)[] = [];
  const starts = await withStubNpm(root, async () => {
    answers = await Promise.all([npmRootOnce(input()), npmRootOnce(input()), npmRootOnce(input())]);
  });
  assert.deepEqual(answers, [root, root, root]);
  assert.equal(starts, 1);
});

test("a failing npm still falls back to the prefix, through the memo", { skip }, async () => {
  let answers: (string | null)[] = [];
  const starts = await withStubNpm(null, async () => {
    const env = { npm_config_prefix: path.resolve(path.sep, "stub", "prefix") };
    answers = [await npmRootOnce(input(env)), await npmRootOnce(input(env))];
  });
  const want = path.join(path.resolve(path.sep, "stub", "prefix"), "lib", "node_modules");
  assert.deepEqual(answers, [want, want]);
  assert.equal(starts, 1);
});

test("a seeded slot answers without starting npm", { skip }, async () => {
  const starts = await withStubNpm("/unused", async () => {
    (globalThis as Record<symbol, unknown>)[KEY] = { seed: "/seeded" };
    assert.equal(await npmRootOnce(input()), "/seeded");
    assert.equal(await npmRootOnce(input()), "/seeded");
  });
  assert.equal(starts, 0);
});

test("piModelDataDir reaching the npm fallback twice starts npm once", { skip }, async () => {
  const world = mkTestTmp("pf-npm-once-root-");
  try {
    const data = path.join(world, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
    fs.mkdirSync(data, { recursive: true });
    let found: unknown[] = [];
    const starts = await withStubNpm(world, () => {
      found = [piModelDataDir(), piModelDataDir()];
    });
    assert.deepEqual(found, [{ dir: data }, { dir: data }]);
    assert.equal(starts, 1);
  } finally {
    rmTestTmp(world);
  }
});

test("piModelDataDir with a failing npm reports not found and does not retry", { skip }, async () => {
  let found: { error?: string }[] = [];
  const starts = await withStubNpm(null, () => {
    found = [piModelDataDir(), piModelDataDir()];
  });
  assert.ok(found.every((r) => /was not found/.test(r.error ?? "")));
  assert.equal(starts, 1);
});

function modelWorld(world: string): string {
  const data = path.join(world, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  fs.mkdirSync(data, { recursive: true });
  return data;
}

test("session lookup then model-data lookup share one npm start", { skip }, async () => {
  const world = mkTestTmp("pf-npm-once-root-");
  try {
    const data = modelWorld(world);
    let found: unknown;
    let session: string | null = null;
    const starts = await withStubNpm(world, async () => {
      session = await npmRootOnce(input());
      found = piModelDataDir();
    });
    assert.equal(session, world);
    assert.deepEqual(found, { dir: data });
    assert.equal(starts, 1);
  } finally {
    rmTestTmp(world);
  }
});

test("model-data lookup then session lookup share one npm start and the same path", { skip }, async () => {
  const world = mkTestTmp("pf-npm-once-root-");
  try {
    const data = modelWorld(world);
    let found: unknown;
    let session: string | null = null;
    const starts = await withStubNpm(world, async () => {
      found = piModelDataDir();
      session = await npmRootOnce(input());
    });
    assert.deepEqual(found, { dir: data });
    assert.equal(session, world);
    assert.equal(starts, 1);
  } finally {
    rmTestTmp(world);
  }
});

test("a failing npm seen by model-data first: the session lookup takes the prefix fallback, one start", { skip }, async () => {
  let found: { error?: string } = {};
  let session: string | null = null;
  const prefix = path.resolve(path.sep, "stub", "prefix");
  const starts = await withStubNpm(null, async () => {
    found = piModelDataDir();
    session = await npmRootOnce(input({ npm_config_prefix: prefix }));
  });
  assert.match(found.error ?? "", /was not found/);
  assert.equal(session, path.join(prefix, "lib", "node_modules"));
  assert.equal(starts, 1);
});

test("a failing npm seen by the session lookup first: model-data reports not found, one start", { skip }, async () => {
  let found: { error?: string } = {};
  let session: string | null = null;
  const prefix = path.resolve(path.sep, "stub", "prefix");
  const starts = await withStubNpm(null, async () => {
    session = await npmRootOnce(input({ npm_config_prefix: prefix }));
    found = piModelDataDir();
  });
  assert.equal(session, path.join(prefix, "lib", "node_modules"));
  assert.match(found.error ?? "", /was not found/);
  assert.equal(starts, 1);
});
