// The win32 branches of the handoff shell rules (intoDirTargets' `path.win32` join, rulingWrite, the subagent `tee` floor) with drive-letter paths as Git Bash
// passes them (forward slashes, either drive-letter case). The rules stat real dirs and take the platform from the call, so this runs on the Windows shard only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const win = process.platform === "win32";
const base = fs.realpathSync(mkTestTmp("pf-hw32-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
const O = path.join(base, "agent", "handoffs", "opened");
const X = path.join(base, "elsewhere");
for (const d of [wt, scr, path.join(H, "work"), O, X]) fs.mkdirSync(d, { recursive: true });
const mkSrc = (): void => fs.writeFileSync(path.join(wt, "a"), "a");
mkSrc();
after(() => fs.rmSync(base, { recursive: true, force: true }));

const fwd = (p: string, lowerDrive = false): string => {
  const s = p.replace(/\\/g, "/");
  return lowerDrive ? s.replace(/^[A-Z]:/, (d) => d.toLowerCase()) : s;
};
const mk = (o: Partial<GateRoots>): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "builder", tmpAccess: false, ...o });
const SUB = mk({ scratch: [scr], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), child: true, childHandoff: H });
const PARENT = mk({ openedHandoffs: [O], role: "foreman" });
const seen = (r: GateRoots, command: string): string => {
  const out = gateEvaluate("bash", { command }, fwd(wt), { env: (cwd) => baseFloorEnv(cwd, { child: r.child, platform: "win32" }), roots: () => r });
  const res = out.result as { allow?: boolean; block?: boolean; rule?: string } | undefined;
  return res?.block ? `block:${res.rule}` : out.danger?.name ?? (res?.allow ? `allow:${res.rule}` : "none");
};

for (const lower of [false, true]) {
  const [w, h, o, x] = [wt, H, O, X].map((p) => fwd(p, lower));
  const tag = lower ? "lower-case drive" : "drive as given";

  test(`intoDirTargets, win32 join (${tag}): mv into work/ is an allow, an option that may move the destination is refused`, { skip: !win }, () => {
    assert.equal(seen(SUB, `mv ${w}/a ${h}/work`), "allow:default-write-in");
    mkSrc();
    for (const f of [`cp -t${x} ${w}/a ${h}/work`, `cp --target=${x} ${w}/a ${h}/work`, `mv -vt${x} ${w}/a ${h}/work`, `mv --targ=${x} ${w}/a ${h}/work`, `mv -t ${x} ${w}/a ${h}/work`]) {
      assert.equal(seen(SUB, f), "block:child-write-outside", f);
      mkSrc();
    }
  });

  test(`rulingWrite, win32 (${tag}): a ruling name of an opened dir is an allow, other names and dirs are not`, { skip: !win }, () => {
    assert.equal(seen(PARENT, `cp ${w}/a ${o}/ruling.md`), "allow:default-write-handoff-ruling");
    mkSrc();
    assert.equal(seen(PARENT, `cp ${w}/a ${o}`), "danger-write-outside");
    assert.equal(seen(PARENT, `cp ${w}/a ${o}/notes.md`), "danger-write-outside");
    assert.equal(seen(PARENT, `cp ${w}/a ${x}/ruling.md`), "danger-write-outside");
  });

  test(`tee floor, win32 (${tag}): a subagent tee outside is child-write-outside, the sinks and own names are not`, { skip: !win }, () => {
    for (const l of [`echo x | tee ${x}/f`, `echo x | tee ${h}/ruling.md`, `echo x | tee ${h}/work/.git/x`]) assert.equal(seen(SUB, l), "block:child-write-outside", l);
    for (const l of [`echo x | tee /dev/null`, `echo x | tee ${w}/f`, `echo x | tee ${h}/result.md`]) assert.notEqual(seen(SUB, l), "block:child-write-outside", l);
  });
}
