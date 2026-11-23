// The judge's file open against a swap of a middle path component (folder <-> symlink to an outside folder): the ancestor checks and the Linux /proc check.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_READ_BUDGET, judgeReadScope, readHooks, readPaths } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-race-")));
const home = path.join(tmp, "home");
const agent = path.join(home, ".pi", "agent");
const wt = path.join(home, "proj");
const outside = path.join(tmp, "elsewhere");
for (const d of [agent, wt, outside]) fs.mkdirSync(d, { recursive: true });
const scope = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, home, platform: process.platform, config: {} }) as JudgeReadScope;
const one = (p: string) => {
  const r = readPaths([p], scope, { left: MAX_READ_BUDGET });
  return { rec: r.records[0], block: r.blocks[0] };
};
let n = 0;
/** A folder `<wt>/dN/mid/<leaf>` inside, and `<outside>/dN/mid/<leaf>` with the same names outside. */
function fixture(leaf: string): { mid: string; inner: string; secret: string } {
  const k = `d${n++}`;
  const mid = path.join(wt, k, "mid");
  fs.mkdirSync(path.join(mid, "deep"), { recursive: true });
  const inner = path.join(mid, leaf);
  fs.writeFileSync(inner, "inside text\n");
  const out = path.join(outside, k);
  fs.mkdirSync(path.join(out, "deep"), { recursive: true });
  fs.writeFileSync(path.join(out, leaf), "OUTSIDE TEXT\n");
  fs.writeFileSync(path.join(out, "deep", "outside-name.txt"), "x\n");
  return { mid, inner, secret: out };
}
/** mid becomes a symlink to the outside folder; the real folder moves aside. */
const swapIn = (mid: string, target: string): void => {
  fs.renameSync(mid, `${mid}.old`);
  fs.symlinkSync(target, mid);
};
const swapBack = (mid: string): void => {
  fs.unlinkSync(mid);
  fs.renameSync(`${mid}.old`, mid);
};

afterEach(() => {
  readHooks.afterStat = undefined;
  readHooks.afterOpen = undefined;
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a middle folder swapped for a link to an outside folder between the check and the open: changed, nothing outside shown", () => {
  const f = fixture("file.txt");
  readHooks.afterStat = () => swapIn(f.mid, f.secret);
  const r = one(f.inner);
  assert.equal(r.rec.outcome, "changed");
  assert.ok(!r.block.body.includes("OUTSIDE"));
});

test("swapped in and swapped back after the open: changed on Linux through /proc", { skip: process.platform === "linux" ? false : "documented gap: off Linux Node has no per-component no-follow open, so a swap back before the next look is not seen" }, () => {
  const f = fixture("file.txt");
  readHooks.afterStat = () => swapIn(f.mid, f.secret);
  readHooks.afterOpen = () => swapBack(f.mid);
  const r = one(f.inner);
  assert.equal(r.rec.outcome, "changed");
  assert.ok(!r.block.body.includes("OUTSIDE"));
});

test("a swap after the open that stays: changed", () => {
  const f = fixture("file.txt");
  readHooks.afterOpen = () => swapIn(f.mid, f.secret);
  const r = one(f.inner);
  assert.equal(r.rec.outcome, "changed");
  assert.ok(!r.block.body.includes("OUTSIDE"));
});

test("listing: a middle folder swapped for a link to an outside folder is changed, no outside names shown", () => {
  const f = fixture("file.txt");
  readHooks.afterStat = () => swapIn(f.mid, f.secret);
  const r = one(`${path.join(f.mid, "deep")}/`);
  assert.equal(r.rec.outcome, "changed");
  assert.ok(!r.block.body.includes("outside-name"));
});

test("no swap: the same reads still work", () => {
  const f = fixture("file.txt");
  assert.equal(one(f.inner).rec.outcome, "ok");
  assert.equal(one(`${path.join(f.mid, "deep")}/`).rec.outcome, "dir");
});
