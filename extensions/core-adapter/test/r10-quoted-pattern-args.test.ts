// R10 P1 item 4 (d): quoted pattern args are never classified as external paths. Reproduced first through the layers:
// - the permission system's bash external-directory gate (pi-permission-system token classifier) names any word that starts with `/` as an
//   external path unless its pattern-first table knows the command: it has no `git` row (`git log -S '/x/'`, `-G`, `--grep`, `-L '/a/,/b/:f'`)
//   and reads only the first two letters of a short-option cluster (`grep -ne '/foo/'`). Its ask reaches the review link as surface
//   external_directory(_read) with a bash payload.
// - the review link CANNOT fix that: PS wraps every authorizer-chain link in encloseInDelegationEnvelope (authority/authorizer-selection.ts,
//   authority/delegation-envelope.ts), which caps an `allow` on the external_directory family to `defer`. A link-level "pattern-arg" allow was
//   therefore dead in production and has been removed. The remaining fix is upstream: the PS bash token classifier
//   (access-intent/bash/token-collection.ts) needs a `git` row (-S/-G/--grep values, the <range> of -L) and short-option-cluster handling for
//   grep/rg `-e`. Until then the ask still reaches the dialog; this is the documented residual.
// - the overlay (checkToolCall): a `git log -S`/`-G`/`--grep` value that names a toolchain probe dir asked (the probe narrowing saw it as a
//   path word); scriptOperands now knows those values, so they drop out of the path words like grep/rg patterns do. This part is ours and works.
// `git log -L <range>:<file>`: only <range> is a non-path; <file> stays a path candidate (finding F).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-pattern-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
// a child runs in its own round worktree (the foreman's workspace is write-protected for children)
const wt = path.join(w, "ws.worktrees", "r1");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [path.join(ws, "src"), path.join(wt, "src"), ag]) fs.mkdirSync(d, { recursive: true });
for (const r of [ws, wt]) fs.writeFileSync(path.join(r, "src", "x.ts"), "x\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ctx = (role: "main" | "child"): MatchCtx => (role === "main" ? { cwd: ws, home, platform: process.platform, role } : { cwd: wt, home, platform: process.platform, role, roundRoots: [wt] });
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules, "bash", { command }, ctx(role))?.kind ?? "pass";

// overlay: a pattern operand is no path word
const OPEN: string[] = [
  "git log -L '/start/,/end/:src/x.ts'",
  "git log -S '/api/v1/' --oneline",
  "git log -G '/usr/.*bin/' -p -- src",
  "git log --grep '/r9/' --oneline",
  "git log --grep=/r9/ --oneline",
  "git log --oneline -S /x/y -G /a/b",
  "grep -ne '/foo/' src/x.ts",
  "grep -n -e '/foo/' -e '/bar/' src",
  "rg -e '/foo/bar' src",
  "sed -n '/a/,/b/p' src/x.ts",
  "git show HEAD:src/x.ts | sed -n '/start/,/end/p' | head -20",
  "cd src && git log -S '/api/' --oneline | head",
];
for (const cmd of OPEN) {
  test(`expected-open (R10d): ${cmd} (overlay pass for foreman and child; the link layer is capped by the PS delegation envelope)`, { skip: !posix }, () => {
    assert.equal(sh("main", cmd), "pass", "overlay foreman");
    assert.equal(sh("child", cmd), "pass", "overlay child");
  });
}

test("expected-open (R10d): a git log -S/-G/--grep value naming a probe dir is a pattern, not a probe path word (overlay)", { skip: !posix }, () => {
  for (const cmd of ["git log -S /usr/local/bin --oneline", "git log -G '/opt/homebrew/bin' -p", "git log --grep /usr/bin"]) {
    assert.equal(sh("main", cmd), "pass", cmd);
    assert.equal(sh("child", cmd), "pass", cmd);
  }
});

test("(decision: ask) a probe dir after `--` or as the <file> of `git log -L` stays a path word (overlay)", { skip: !posix }, () => {
  for (const cmd of ["git log -S x -- /usr/local/bin", "git log -L '1,5:/usr/local/bin/x'", "git log -L '/a/,/b/:/usr/local/bin/x'"]) {
    assert.equal(sh("main", cmd), "ask", cmd);
    assert.equal(sh("child", cmd), "ask", cmd);
  }
});
