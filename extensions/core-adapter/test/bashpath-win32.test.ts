// Ledger r8 item 6: the Windows CI shapes of permoverlay-vars (721, 723, 724) and shellvars-cases (1145, 1148), simulated on
// every host: an injected platform "win32", a path.win32 world below the runner's 8.3 temp dir (C:\Users\RUNNER~1\...) and the
// fixture paths spelled by bashPath. A protected path held in a variable is denied (never pass), as on POSIX.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { bashPath, bashQuoted } from "./_bashpath.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const W = path.win32;
const w = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-vars-AbC123";
const ws = W.join(w, "ws");
const wt = W.join(w, "ws.worktrees", "hf");
const home = W.join(w, "home");
const ag = W.join(home, ".pi", "agent");
const scratch = W.join(w, "tmp", "pi-foreman-scratch", "s1", "L1");
const foremanDir = W.join(ag, "pi-foreman");
const blocked = "handoffs/s1/ruling.md";
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, ag, ws, undefined, false);
const world = (role: "main" | "child", extra: Partial<MatchCtx> = {}): MatchCtx => ({ cwd: wt, home, platform: "win32", role, exists: () => false, isDir: () => false, realpath: () => null, list: () => [], ...extra });
const sh = (c: MatchCtx, command: string): string => checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
const child = world("child", { scratch });
const b = (p: string): string => bashPath(p, "win32");

test("bashPath / bashQuoted: forward slashes or double quotes on win32, unchanged elsewhere", () => {
  assert.equal(bashPath("C:\\Users\\RUNNER~1\\x", "win32"), "C:/Users/RUNNER~1/x");
  assert.equal(bashQuoted("C:\\Users\\x", "win32"), '"C:\\Users\\x"');
  for (const platform of ["linux", "darwin"]) {
    assert.equal(bashPath("/tmp/a\\b", platform), "/tmp/a\\b");
    assert.equal(bashQuoted("/tmp/a", platform), "/tmp/a");
  }
});

test("win32: D=C:/Users/RUNNER~1/.../L1/x; mkdir -p $D (721)", () => {
  assert.equal(sh(child, `D=${b(scratch)}/x; mkdir -p $D`), "pass");
  assert.equal(sh(child, `D=${b(scratch)}/x && mkdir -p "$D"`), "pass");
  assert.equal(sh(child, `mkdir -p ${b(scratch)}/x`), "pass");
  assert.equal(sh(child, `cat ${b(foremanDir)}/${blocked}`), "deny");
  assert.equal(sh(child, `H=${b(foremanDir)}; cat $H/${blocked}`), "deny");
  assert.equal(sh(child, `H=${b(foremanDir)}; cat \${H}/${blocked}`), "deny");
  assert.equal(sh(child, `H=${bashQuoted(foremanDir, "win32")}; cat $H/${blocked}`), "deny");
  assert.equal(sh(world("main"), `S=${b(home)}/.ssh; cat $S/id_rsa`), "deny");
});

test("win32: D=C:/Users/RUNNER~1/.../pi-foreman; cat $D/handoffs/s1/ruling.md is not the unknown-$D decision (723)", () => {
  const unknown = sh(child, `cat $D/${blocked}`);
  assert.equal(sh(child, `D=${b(foremanDir)} cat $D/${blocked}`), unknown, "a prefix assignment stays unresolved");
  assert.notEqual(sh(child, `D=${b(foremanDir)}; cat $D/${blocked}`), unknown);
  assert.equal(sh(child, `D=${b(foremanDir)}; cat $D/${blocked}`), "deny");
});

test("win32: D=<scratch>; D=C:/Users/RUNNER~1/.../pi-foreman; cat $D/handoffs/s1/ruling.md (724)", () => {
  assert.equal(sh(child, `D=${b(foremanDir)}; D=${b(scratch)}; cat $D/${blocked}`), "pass");
  assert.equal(sh(child, `D=${b(scratch)}; D=${b(foremanDir)}; cat $D/${blocked}`), "deny");
});

test("win32: cd C:/Users/RUNNER~1/.../home/.ssh; H=$PWD; cat $H/id_rsa (1148)", () => {
  const ssh = W.join(home, ".ssh");
  assert.equal(sh(world("main"), `cd ${b(ssh)}; H=$PWD; cat $H/id_rsa`), "deny");
  assert.equal(sh(world("main"), `cd ${b(home)}; H=$PWD/.ssh; cat "$H/id_rsa"`), "deny");
  assert.equal(sh(world("main"), `cd ${b(wt)}; H=$PWD; cat $H/id_rsa`), "pass", "a path under the worktree is not protected");
});

test("win32: cd C:/Users/RUNNER~1/.../hf; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt (1145)", () => {
  for (const role of ["child", "main"] as const) {
    const c = world(role, { scratch });
    assert.equal(sh(c, `cd ${b(wt)}; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt`), "pass", role);
    assert.equal(sh(c, `S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > "$S/tc.txt"`), "pass", role);
  }
});

test("win32: S=$FOREMAN_SCRATCH; python3 - \"$S/probe.test.ts\" <<EOF is decided like its literal-path line (1146)", () => {
  const body = "\nprint(1)\nEOF";
  for (const role of ["child", "main"] as const) {
    const c = world(role, { scratch });
    assert.equal(sh(c, `S=$FOREMAN_SCRATCH; python3 - "$S/probe.test.ts" <<EOF${body}`), sh(c, `python3 - "${scratch}/probe.test.ts" <<EOF${body}`), role);
  }
});
