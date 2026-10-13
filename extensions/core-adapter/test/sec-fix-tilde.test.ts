// SEC-fix-2 G3/G4: a pure read of the state dir in `~/` / `$HOME/` / absolute form passes for the foreman (writes still ask);
// a child's `$S` / `$FOREMAN_SCRATCH` redirect target is a scratch write.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { ownedRoots } from "../owned.ts";
import { childSurface } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-sectilde-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
const usage = path.join(agentDir, "pi-foreman", "state", "usage");
for (const d of [path.join(main, ".workflow"), usage, scratch, rt]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(usage, "sess.jsonl"), "{}\n");
if (posix) execFileSync("git", ["init", "-q", rt], { stdio: "ignore" });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

const foreman = (command: string): string => checkToolCall(rules, "bash", { command }, { cwd: main, home, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const child = (command: string, env: Partial<MatchCtx> = {}): string => {
  const s = childSurface([rt], rt, "reviewer", process.platform);
  const ctx: MatchCtx = { cwd: rt, home, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read, ...env };
  const d = checkToolCall(rules, "bash", { command }, ctx);
  return d ? `${d.kind}` : "pass";
};
const why = (command: string): string => foremanWhy(command);
const foremanWhy = (command: string): string => checkToolCall(rules, "bash", { command }, { cwd: rt, home, platform: process.platform, role: "child", scratch, roundRoots: childSurface([rt], rt, "reviewer", process.platform).write, roundReadRoots: childSurface([rt], rt, "reviewer", process.platform).read })?.reason ?? "pass";

test("G3: a pure read of the state dir passes in the ~/, $HOME/ and absolute forms", { skip: !posix }, () => {
  const f = "~/.pi/agent/pi-foreman/state/usage/sess.jsonl";
  for (const p of [f, f.replace("~", "$HOME"), f.replace("~", "${HOME}"), path.join(usage, "sess.jsonl")]) {
    assert.equal(foreman(`head -c 600 ${p}; echo; wc -l ${p}`), "pass", p);
    assert.equal(foreman(`cat ${p}`), "pass", p);
    assert.equal(foreman(`wc -l ${p}`), "pass", p);
  }
});

test("G3: writes to the state dir through ~/ and $HOME/ still ask or deny", { skip: !posix }, () => {
  const f = "~/.pi/agent/pi-foreman/state/usage/sess.jsonl";
  for (const p of [f, f.replace("~", "$HOME")]) {
    for (const cmd of [`echo x > ${p}`, `echo x >> ${p}`, `echo x | tee ${p}`, `cp x ${p}`, `mv x ${p}`, `head -c 5 ${p}; echo x > ${p}`]) {
      assert.notEqual(foreman(cmd), "pass", cmd);
    }
  }
});

test("G4: a child's $S / $FOREMAN_SCRATCH redirect is a scratch write; escapes stay denied", { skip: !posix }, () => {
  const at = (cwd: string, line: string): string => child(line, { cwd });
  for (const cwd of [rt]) {
    for (const line of [
      `npm run typecheck > $FOREMAN_SCRATCH/typecheck.log 2>&1`,
      `npm run typecheck > $S/typecheck.log 2>&1`,
      `npm run typecheck > "$S/typecheck.log" 2>&1`,
    ]) assert.equal(at(cwd, line), "pass", `${cwd}: ${line}: ${why(line)}`);
    for (const line of [
      `S=$FOREMAN_SCRATCH; npm run typecheck > $S/../x 2>&1`,
      `npm run typecheck > $S/../x 2>&1`,
      `npm run typecheck > $OTHER/x.log 2>&1`,
      `O=${rt}; npm run typecheck > $O/x.log 2>&1`,
      `S=${rt}; npm run typecheck > $S/x.log 2>&1`,
      `npm run typecheck > ${rt}/x.log 2>&1`,
    ]) assert.notEqual(at(cwd, line), "pass", `${cwd}: ${line}`);
  }
});
