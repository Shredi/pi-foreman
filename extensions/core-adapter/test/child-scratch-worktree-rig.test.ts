// D82 through the adapter hooks: a single launch gets $FOREMAN_SCRATCH under the configured worktree root once the npm root resolved, the temp folder
// before that and outside git.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { lightSpawner } from "./_light-spawner.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-d82rig-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const fakeRepo = (): string => {
  const dir = path.join(base, `repo${++n}`);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(dir, ".workflow"));
  return dir;
};
const NPM = Symbol.for("pi-foreman.npm-root");
type Slot = { seed?: string | null; pending?: Promise<string | null> };
const scratchOf = (input: Record<string, unknown>): string | undefined => ((input.extensionBindings as Record<string, { scratch?: string }> | undefined)?.["pi-foreman/1"])?.scratch;

const rig = (t: Parameters<typeof r11Rig>[0], cwd: string, close?: Record<string, unknown>) =>
  r11Rig(t, { default: "standard" }, {
    ctx: { ...reviewAllowOpts().ctx, cwd, model: { provider: "fake", id: "foreman" } },
    config: { providers: { fake: { review: { model: "m" }, roles: { builder: { model: "fake/builder" } } } }, ...(close ? { close } : {}) },
    deps: { spawner: lightSpawner() }, // the cases read the scratch binding, not the spawn gate's answer
  });

test("default close.worktreeDir: $FOREMAN_SCRATCH is under ../<repo>.worktrees/.foreman/scratch/<session>/, traced once as worktree", async (t) => {
  const repo = fakeRepo();
  const a = await rig(t, repo);
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  assert.equal((await a.launch(input)).res, undefined);
  const dir = scratchOf(input)!;
  const root = path.join(base, `${path.basename(repo)}.worktrees`);
  assert.ok(dir.startsWith(path.join(root, ".foreman", "scratch", a.sessionId) + path.sep), dir);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.match(String(input.task), new RegExp(`Your scratch dir: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
  assert.deepEqual(a.events("child_scratch_root").map((r) => r.source), ["worktree"]);
});

test("a custom close.worktreeDir: $FOREMAN_SCRATCH is under that root", async (t) => {
  const repo = fakeRepo();
  const a = await rig(t, repo, { worktreeDir: `../custom-root${n}` });
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  assert.equal((await a.launch(input)).res, undefined);
  assert.ok(scratchOf(input)!.startsWith(path.join(base, `custom-root${n}`, ".foreman", "scratch", a.sessionId) + path.sep), scratchOf(input));
});

test("a session without a launch has no child_scratch_root event", async (t) => {
  const a = await rig(t, fakeRepo());
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(a.events("child_scratch_root"), []);
});

test("a non-git cwd: the temp folder", async (t) => {
  const plain = path.join(base, "plain");
  fs.mkdirSync(plain);
  const a = await rig(t, plain);
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  assert.equal((await a.launch(input)).res, undefined);
  assert.ok(scratchOf(input)!.startsWith(path.join(fs.realpathSync.native(os.tmpdir()), "pi-foreman-scratch", a.sessionId) + path.sep), scratchOf(input));
  assert.deepEqual(a.events("child_scratch_root").map((r) => r.source), ["tmp"]);
});

test("before the npm root resolves a launch uses the temp folder; after it, the worktree root", async (t) => {
  const g = globalThis as Record<symbol, Slot | undefined>;
  const slot = (g[NPM] ??= {});
  const saved = { seed: slot.seed, pending: slot.pending };
  let resolve!: (v: string | null) => void;
  slot.seed = undefined;
  slot.pending = new Promise<string | null>((r) => (resolve = r));
  t.after(() => {
    slot.seed = saved.seed;
    slot.pending = saved.pending;
  });
  const repo = fakeRepo();
  const a = await rig(t, repo);
  const early: Record<string, unknown> = { agent: "builder", task: "go" };
  assert.equal((await a.launch(early)).res, undefined);
  assert.ok(scratchOf(early)!.startsWith(path.join(fs.realpathSync.native(os.tmpdir()), "pi-foreman-scratch") + path.sep), scratchOf(early));
  assert.deepEqual(a.events("child_scratch_root").map((r) => r.source), ["tmp"]);
  resolve(path.join(base, "fake-npm", "node_modules"));
  const wtRoot = path.join(base, `${path.basename(repo)}.worktrees`, ".foreman", "scratch") + path.sep;
  let late: Record<string, unknown> = { agent: "builder", task: "go" };
  for (let i = 0; i < 50; i++) {
    late = { agent: "builder", task: "go" };
    assert.equal((await a.launch(late)).res, undefined);
    if (scratchOf(late)!.startsWith(wtRoot)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(a.events("child_scratch_root").map((r) => r.source), ["tmp"]); // once per session, at the first launch
  assert.ok(scratchOf(late)!.startsWith(path.join(base, `${path.basename(repo)}.worktrees`, ".foreman", "scratch") + path.sep), scratchOf(late));
});

