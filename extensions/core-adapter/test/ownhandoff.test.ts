// R3b point 8b: the "own-handoff" deterministic allow for `cp`/`mkdir`/`cat`/`ls` below the session's own
// handoff dirs and its round worktree (the R3 ask lines), and nothing else.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp } from "./_tmpbase.ts";
import { effectCtx } from "../effects.ts";
import { readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});
const base = fs.realpathSync.native(mkTestTmp("pf-ownho-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const wt = path.join(base, "repo.worktrees", "round");
const handoff = path.join(base, "agent", "pi-foreman", "handoffs", "20260101-000000-demo");
const other = path.join(base, "agent", "pi-foreman", "handoffs", "20260101-000001-other");
for (const d of [path.join(wt, ".git"), path.join(wt, ".workflow", "scratch"), handoff, other]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, ".workflow", "scratch", "plan-chair-mechanics.md"), "plan\n");
fs.writeFileSync(path.join(handoff, "brief.md"), "brief\n");
fs.writeFileSync(path.join(handoff, "parent"), "p-1\n");
fs.writeFileSync(path.join(handoff, "child"), "fm-demo-abc123\n");
const posix = process.platform !== "win32";
const allow = (cmd: string, own: string[] = [handoff]): string | null => deterministicAllow(rules, cmd, { effects: effectCtx(wt), ownDirs: own });

test("R3 line: mkdir in the round worktree and cp the brief out of the own handoff dir", { skip: !posix }, () => {
  const scratch = `${wt}/.workflow/scratch/pi-top-chair`;
  assert.equal(allow(`mkdir -p ${scratch} && cp ${handoff}/brief.md ${scratch}/brief.md`), "own-handoff");
});

test("R3 line: cp into the own handoff dir, then cat the parent file and ls the dir", { skip: !posix }, () => {
  assert.equal(allow(`cp ${wt}/.workflow/scratch/plan-chair-mechanics.md ${handoff}/plan.md && cat ${handoff}/parent; ls ${handoff}`), "own-handoff");
});

test("a trailing <dir>/* glob is accepted on a read", { skip: !posix }, () => {
  assert.equal(allow(`mkdir -p ${wt}/.workflow/scratch/copy && cp ${handoff}/* ${wt}/.workflow/scratch/copy`), "own-handoff");
  assert.equal(allow(`ls ${handoff}/*`), "own-handoff");
});

test("not allowed by this rule: the parent and child files, other handoff dirs, paths outside the two roots", { skip: !posix }, () => {
  const no = (cmd: string, own?: string[]): void => assert.notEqual(allow(cmd, own), "own-handoff", cmd);
  no(`cp x ${handoff}/parent`);
  no(`cp x ${handoff}/child`);
  no(`mkdir ${handoff}/parent`);
  no(`cp ${wt}/.workflow/scratch/plan-chair-mechanics.md ${handoff}/`);
  no(`cp ${handoff}/parent ${handoff}/`);
  no(`mkdir /elsewhere/x`);
  no(`cp ${handoff}/brief.md /elsewhere/x`);
  no(`cp ${handoff}/brief.md ${other}/brief.md`);
  no(`mkdir -p ${other}/x`);
  no(`cp -r ${handoff} ${wt}/copy`);
  no(`cp ${handoff}/brief.md ${wt}/.git/hooks-x`);
  no(`cp ${handoff}/brief.md ${wt}/x > ${wt}/log`);
  no(`mkdir -p ${handoff}/../x`);
  no(`cp ${handoff}/brief.md ${wt}/x`, []);
  no(`rm ${handoff}/brief.md`);
  no(`cp ${handoff}/brief.md ${wt}/x/*`);
  for (const cmd of [`rm -rf ${wt}/src/*`, `grep -n x ${handoff}/*`, `rm ${handoff}/*`]) assert.equal(allow(cmd), null, cmd);
  no(`cat /etc/hosts`);
});

test("a symlink inside the handoff dir cannot lead a write out", { skip: !posix }, () => {
  const out = path.join(base, "outside");
  fs.mkdirSync(out, { recursive: true });
  fs.symlinkSync(out, path.join(handoff, "esc"));
  assert.notEqual(allow(`cp ${handoff}/brief.md ${handoff}/esc/b.md`), "own-handoff");
});

test("the link allows the foreman's own (not forwarded) ask without the model, and only for this label", async () => {
  const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
  const r = new ForemanReview();
  const s: ReviewSession = { isChild: false, cwd: wt, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules, ownDirs: () => [handoff] };
  r.upsert("s", s);
  const own = { requestId: "r", surface: "bash", agentName: "foreman", value: `cp ${handoff}/brief.md ${wt}/.workflow/scratch/b.md` };
  if (posix) assert.deepEqual(await r.authorize("s", own), { kind: "allow" });
  if (posix) assert.deepEqual(await r.authorize("s", { ...own, value: `mkdir -p ${wt}/x` }), { kind: "allow" });
  const asked = await r.authorize("s", { ...own, value: "git push origin main" });
  assert.notEqual(asked.kind, "allow");
});
