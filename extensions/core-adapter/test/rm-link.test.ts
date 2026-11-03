// A6: a plain rm / unlink / rmdir of a symlink is judged on the link (realpath(dirname) + name); -r and a trailing slash keep the target's judgement.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { writesOutside } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { realSpelling } from "../pathrules.ts";
import { contained, effectCtx } from "../effects.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-rmlink-"));
const wt = path.join(base, "wt");
const outside = path.join(base, "outside");
after(() => fs.rmSync(base, { recursive: true, force: true }));
fs.mkdirSync(path.join(wt, "sub"), { recursive: true });
fs.mkdirSync(path.join(wt, ".git"));
fs.mkdirSync(path.join(outside, "d"), { recursive: true });
fs.writeFileSync(path.join(outside, "f"), "x\n");
if (posix) {
  fs.symlinkSync(path.join(outside, "f"), path.join(wt, "flink"));
  fs.symlinkSync(path.join(outside, "d"), path.join(wt, "dlink"));
  fs.symlinkSync(outside, path.join(wt, "sub", "up"));
}
const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false };
const out = (line: string): boolean => writesOutside({ tool: "bash", input: { command: line }, segments: parseShell(line, { cwd: wt }), text: line }, { roots, platform: process.platform, cwd: wt });

test("rm / unlink of a symlink inside the checkout pointing outside is a write in; -r, a trailing slash and a path through the link keep today's judgement", { skip: !posix }, () => {
  for (const l of ["rm flink", "rm -f flink", "rm dlink", "unlink flink", "unlink dlink", "rm sub/up", "rm -f -- dlink"]) assert.equal(out(l), false, l);
  for (const l of ["rm -r dlink", "rm -rf dlink", "rm -R dlink", "rm dlink/", "rm -f flink/", "rm sub/up/f", "rm dlink/x", "touch flink", "rm -r sub/up"]) assert.equal(out(l), true, l);
  // a real file inside stays a write in; a target outside the checkout stays out
  assert.equal(out("rm sub/none"), false);
  assert.equal(out(`rm ${path.join(outside, "f")}`), true);
});

test("effects contained(): the link flag resolves only the directory", { skip: !posix }, () => {
  const c = effectCtx(wt, []);
  assert.equal(contained(c, wt, "flink", true, undefined, true), true);
  assert.equal(contained(c, wt, "flink", true), false);
  assert.equal(contained(c, wt, "dlink/", true, undefined, false), false);
  assert.equal(contained(c, wt, ".", true, undefined, true), false);
});

test("realSpelling(link): realpath of the directory plus the name", { skip: !posix }, () => {
  const real = (p: string): string | null => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  };
  assert.equal(realSpelling("posix", path.join(wt, "flink"), real, true), path.join(wt, "flink"));
  assert.equal(realSpelling("posix", path.join(wt, "flink"), real), path.join(outside, "f"));
  assert.equal(realSpelling("posix", path.join(wt, "sub", "up", "f"), real, true), path.join(outside, "f"));
});
