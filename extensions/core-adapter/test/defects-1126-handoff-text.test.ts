// D193: a shell copy into the own handoff dir under a name the child side may not write gets a handoff-specific refusal text, in every edit mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

async function setup(t: { after(fn: () => void | Promise<void>): void }, ceremony: Record<string, unknown> = {}) {
  const rig = await r11Rig(t, ceremony);
  // native: the long spelling the gate resolves to
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-d193-")));
  const prev = process.env.PI_FOREMAN_HANDOFF_DIR;
  process.env.PI_FOREMAN_HANDOFF_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
    else process.env.PI_FOREMAN_HANDOFF_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(rig.project, ".workflow", "scratch"), { recursive: true });
  const src = path.join(rig.project, ".workflow", "scratch", "plan-x.md");
  fs.writeFileSync(src, "plan\n");
  // the command line is shell text: forward slashes, a backslash would be eaten
  const sh = (p: string): string => p.replaceAll("\\", "/");
  return { rig, dir: sh(dir), src: sh(src) };
}

test("a refused copy into the handoff dir names the allowed handoff file names, not the edit-mode text", async (t) => {
  const { rig, dir, src } = await setup(t);
  const v = await rig.call("bash", { command: `cp ${src} ${dir}/plan-draft.md` });
  assert.equal(v?.block, true, JSON.stringify(v));
  const text = v?.reason ?? "";
  for (const name of ["plan.md", "result.md", "ask.md", "ask-<n>.md", "work/"]) assert.ok(text.includes(name), `${name}: ${text}`);
  assert.ok(!text.includes(".steer-last-read.json"), text);
  assert.ok(!/\.workflow\/ is writable/.test(text), text);
});

test("the handoff names stay writable: plan.md and below work/", async (t) => {
  const { rig, dir, src } = await setup(t);
  fs.mkdirSync(path.join(dir, "work"), { recursive: true });
  assert.equal((await rig.call("bash", { command: `cp ${src} ${dir}/plan.md` }))?.block, undefined);
  assert.equal((await rig.call("bash", { command: `cp ${src} ${dir}/work/x` }))?.block, undefined);
});

test("a refusal of a project file keeps the edit-mode text", async (t) => {
  const { rig } = await setup(t);
  const v = await rig.call("bash", { command: `cp ${rig.project}/.workflow/scratch/plan-x.md ${rig.project}/src-file.txt` });
  assert.equal(v?.block, true, JSON.stringify(v));
  assert.match(v?.reason ?? "", /\.workflow\/ is writable|edits are/);
  assert.ok(!(v?.reason ?? "").includes("ask-<n>.md"), v?.reason);
});

test("the handoff text is the same in bounded edit mode", async (t) => {
  const { rig, dir, src } = await setup(t, { foremanEdits: "bounded" });
  const v = await rig.call("bash", { command: `cp ${src} ${dir}/plan-draft.md` });
  assert.equal(v?.block, true, JSON.stringify(v));
  for (const name of ["plan.md", "result.md", "ask.md", "ask-<n>.md", "work/"]) assert.ok((v?.reason ?? "").includes(name), `${name}: ${v?.reason}`);
});
