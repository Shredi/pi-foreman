// D135: a resumed child keeps the first launch's FOREMAN_SCRATCH path; the first run's end removed that dir, so the resume makes it again at the same path and the
// resumed run's end removes it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { ChildScratch, finishScratch, launchScratch, resumeScratch } from "../childscratch.ts";
import type { ScratchHost } from "../childscratch.ts";
import type { LaunchBinding } from "../usage.ts";
import { launch, setup } from "./_hsrig.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-resume-scratch-"));
const tmp = path.join(base, "tmp");
const repo = path.join(base, "repo");
fs.mkdirSync(tmp);
fs.mkdirSync(repo);
const deps = { tmpdir: () => tmp };
after(() => fs.rmSync(base, { recursive: true, force: true }));

const host = (keep = false): ScratchHost => ({ id: "sess-r", cwd: repo, config: { config: { ceremony: { childScratch: { keep } } } }, trace: { emit: () => undefined }, scratch: new ChildScratch() });
const binding = (launchId: string): LaunchBinding => ({ foremanSession: "sess-r", workspace: repo, role: "builder", launchId, kind: "first", model: null });

test("resumeScratch: after the first run's end the dir is made again at the same path and removed when the resumed run ends", () => {
  const h = host();
  const b = binding("L-r1");
  launchScratch(h, {}, b, deps);
  const dir = b.scratch!;
  assert.equal(h.scratch.onLaunched("L-r1", "run-1"), null);
  finishScratch(h, h.scratch.onRunEnd("run-1"), deps);
  assert.equal(fs.existsSync(dir), false, "the first run's end removed it");

  assert.equal(resumeScratch(h, "L-r1", deps), "L-r1");
  assert.ok(fs.statSync(dir).isDirectory(), "same path, exists again");
  assert.deepEqual(h.scratch.live("builder"), [dir]);
  assert.equal(h.scratch.onLaunched("L-r1", "run-2"), null);
  fs.writeFileSync(path.join(dir, "x.txt"), "x");
  finishScratch(h, h.scratch.onRunEnd("run-2"), deps);
  assert.equal(fs.existsSync(dir), false, "removed at the resumed run's end");

  // and once more: a second resume works the same
  assert.equal(resumeScratch(h, "L-r1", deps), "L-r1");
  assert.ok(fs.statSync(dir).isDirectory());
  finishScratch(h, h.scratch.onLaunched("L-r1", null), deps);
  assert.equal(fs.existsSync(dir), false, "a resume that started no run is finished at once");
});

test("resumeScratch: an unknown launch makes nothing; a dir that still exists is kept with its files", () => {
  const h = host();
  assert.equal(resumeScratch(h, "no-such-launch", deps), null);
  const b = binding("L-r2");
  launchScratch(h, {}, b, deps);
  fs.writeFileSync(path.join(b.scratch!, "keep.txt"), "k");
  assert.equal(resumeScratch(h, "L-r2", deps), "L-r2", "a live launch");
  finishScratch(h, h.scratch.onLaunched("L-r2", null), deps);
  const kept = host(true);
  const b3 = binding("L-r3");
  launchScratch(kept, {}, b3, deps);
  finishScratch(kept, kept.scratch.onLaunched("L-r3", null), deps);
  assert.equal(resumeScratch(kept, "L-r3", deps), "L-r3");
  assert.ok(fs.existsSync(b3.scratch!), "kept scratch stays");
});

test("adapter: a resumed builder's FOREMAN_SCRATCH dir exists again at the first launch's path, and the resumed run's end removes it", async (t) => {
  const { a } = await setup(t);
  const first = await launch(a, "builder", "build it");
  assert.equal(first.blocked, null, String(first.blocked));
  const scratch = (first.input.extensionBindings as Record<string, { scratch?: string }>)["pi-foreman/1"].scratch!;
  assert.ok(fs.existsSync(scratch), "created at the launch");
  await a.endRunAs(first.id, "builder", "done");
  assert.equal(fs.existsSync(scratch), false, "the first run's end removed it");

  const resumed = await launch(a, "builder", "x", { action: "resume", id: `run-${first.id}`, message: "go on" });
  assert.equal(resumed.blocked, null, String(resumed.blocked));
  assert.ok(fs.statSync(scratch).isDirectory(), "the resumed child's path exists");
  await a.endRunAs(resumed.id, "builder", "done");
  assert.equal(fs.existsSync(scratch), false, "removed after the resumed run ends");
});
