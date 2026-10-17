// R10 P1 item 6 (f): a child's `npm ci` / `npm install --package-lock-only` runs unasked in its own worktree root AND its subdirs (a `bench/pi-lock`
// shaped package): the session cwd below the root, `cd <sub> && npm ...`, `--prefix <sub>`. Every directory npm may run in (each cwd the cd chain
// can leave, each --prefix, and without --prefix the dir npm itself takes: the nearest ancestor with package.json or node_modules) must
// realpath inside the owned root, so a symlink out of it asks. Env-prefix fail-closed and the unsafe-argument rule are unchanged.
// Reproduced first: the overlay (checkShell -> npmInstallOwned) asked for every subdir form (cdSeen, cwd === root equality) and for
// --package-lock-only (not in NPM_INSTALL_FLAGS). The permission system's own bash rules are not involved for a child (the overlay ask is the
// child's decision).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { bashPath } from "./_bashpath.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-npm-sub-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const owned = path.join(w, "ws.worktrees", "r1");
const lock = path.join(owned, "bench", "pi-lock");
const other = path.join(w, "other");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
// a second owned root without package.json below a dir with node_modules: npm run in its subdir takes that outer dir as its prefix
const up = path.join(w, "up");
const owned2 = path.join(up, "r2");
for (const d of [ws, lock, path.join(owned, "sub"), other, ag, path.join(up, "node_modules"), path.join(owned2, "sub")]) fs.mkdirSync(d, { recursive: true });
for (const d of [owned, lock, other]) fs.writeFileSync(path.join(d, "package.json"), "{}\n");
if (posix) {
  fs.symlinkSync(other, path.join(owned, "esc"));
  fs.symlinkSync(other, path.join(owned, "bench", "esc"));
}

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const run = (cwd: string, command: string, roots = [owned]): string => {
  const ctx: MatchCtx = { cwd, home, platform: process.platform, role: "child", roundRoots: roots };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};

const OPEN: [string, string][] = [
  [owned, "npm ci --package-lock-only"],
  [owned, "npm install --package-lock-only"],
  [owned, "npm install --package-lock-only --ignore-scripts"],
  [owned, "cd bench/pi-lock && npm ci"],
  [owned, "cd bench/pi-lock && npm install --package-lock-only --ignore-scripts"],
  [owned, "cd sub && npm ci"],
  [owned, "npm ci --prefix bench/pi-lock"],
  [owned, "npm install --package-lock-only --prefix=bench/pi-lock"],
  [owned, `npm install --package-lock-only --ignore-scripts --prefix ${bashPath(lock)}`],
  [owned, "cd bench/pi-lock && npm ci --prefix ."],
  [lock, "npm ci"],
  [lock, "npm install --package-lock-only"],
  [lock, "npm ci --prefix ../.."],
  [path.join(owned, "sub"), "npm ci"],
];
for (const [cwd, cmd] of OPEN) {
  test(`expected-open (R10f): child in ${path.relative(w, cwd)}: ${cmd} (overlay pass)`, { skip: !posix }, () => {
    assert.equal(run(cwd, cmd), "pass");
  });
}

// a child's cd out of its owned root (a symlink included) or a cd it cannot resolve is denied before the npm pre-allow (childCdDeny, unchanged)
const DENY: [string, string][] = [
  [owned, "cd esc && npm ci"],
  [owned, "cd bench/esc && npm install --package-lock-only"],
  [owned, "cd .. && npm ci"],
  [owned, `cd ${other} && npm ci`],
  [owned, "cd bench/pi-lock && npm ci && cd ../../.. && npm ci"],
  [owned, "cd bench/pi-lock; cd ../../..; npm ci"],
  [owned, "cd && npm ci"],
  [owned, "cd ~ && npm ci"],
  [owned, "cd - && npm ci"],
  [owned, "cd $D && npm ci"],
];
for (const [cwd, cmd] of DENY) {
  test(`(decision: deny) child in ${path.relative(w, cwd)}: ${cmd} (overlay, cd guard)`, { skip: !posix }, () => {
    assert.equal(run(cwd, cmd, [owned, owned2]), "deny");
  });
}

const ASK: [string, string][] = [
  // a symlink out of the owned root: by --prefix, as the cwd
  [owned, "npm ci --prefix esc"],
  [owned, "npm ci --prefix=bench/esc"],
  [path.join(owned, "esc"), "npm ci"],
  // --prefix or cd outside the root
  [owned, `npm ci --prefix ${other}`],
  [owned, "npm ci --prefix ../../other"],
  [lock, "npm ci --prefix ../../.."],
  // every subset of the cd chain is a possible cwd (a failed cd leaves the dir as it was): `<root>/pi-lock` does not exist
  [owned, "cd bench && cd pi-lock && npm ci"],
  // a cd form the pre-allow does not resolve
  [owned, "pushd bench/pi-lock && npm ci"],
  [owned, "cd -P bench/pi-lock && npm ci"],
  [owned, "X=1 cd bench/pi-lock && npm ci"],
  [owned, "sh -c 'cd bench/pi-lock && npm ci'"],
  // env prefix fail-closed, unsafe arguments, other asks next to it
  [owned, "cd bench/pi-lock && FOO=1 npm ci"],
  [lock, "npm_config_prefix=/elsewhere npm install --package-lock-only"],
  [owned, "cd bench/pi-lock && npm install left-pad"],
  [owned, "npm install --package-lock-only -g"],
  [owned, "cd bench/pi-lock && npm ci && git fetch origin"],
  // npm without --prefix in a subdir takes the nearest ancestor with package.json or node_modules: here one above the owned root
  [path.join(owned2, "sub"), "npm ci"],
  [owned2, "cd sub && npm install --package-lock-only"],
  // not owned at all
  [other, "npm ci --package-lock-only"],
];
for (const [cwd, cmd] of ASK) {
  test(`(decision: ask) child in ${path.relative(w, cwd)}: ${cmd} (overlay)`, { skip: !posix }, () => {
    assert.equal(run(cwd, cmd, [owned, owned2]), "ask");
  });
}

test("(decision: ask) child in an owned root without package.json below a dir with node_modules: npm ci (npm would take that outer dir as its prefix)", { skip: !posix }, () => {
  assert.equal(run(owned2, "npm ci", [owned2]), "ask");
});

// win32 twin (npmInstallOwnedWin32): simulated, injected platform and file system, 8.3 short root
const SHORT_BASE = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-r10-npm-sub-x";
const toLong = (p: string): string => p.replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, "C:\\Users\\runneradmin");
const fwd = (p: string): string => p.replace(/\\/g, "/");
const WOWNED = path.win32.join(SHORT_BASE, "ws.worktrees", "r1");
const WOTHER = path.win32.join(SHORT_BASE, "other");
const WLINK = path.win32.join(WOWNED, "esc");
const wHome = path.win32.join(SHORT_BASE, "home");
const wrules = buildOverlayRules(baseline, {}, {}, path.win32.join(wHome, ".pi", "agent"), path.win32.join(SHORT_BASE, "ws"), undefined, false);
const viaLink = (p: string): string => (p.toLowerCase() === WLINK.toLowerCase() || p.toLowerCase().startsWith(WLINK.toLowerCase() + "\\") ? WOTHER + p.slice(WLINK.length) : p);
const wctx = (cwd = WOWNED): MatchCtx => ({ cwd, home: wHome, platform: "win32", role: "child", roundRoots: [WOWNED], exists: () => true, isDir: () => true, realpath: (p) => viaLink(path.win32.resolve(p)), realpathNative: (p) => toLong(viaLink(path.win32.resolve(p))), list: () => [] });
const wrun = (command: string, cwd?: string): string => checkToolCall(wrules, "bash", { command }, wctx(cwd))?.kind ?? "pass";

test("expected-open (R10f): win32 child: cd bench/pi-lock && npm ci, --prefix=<root>/bench/pi-lock, cwd bench\\pi-lock with --package-lock-only", () => {
  assert.equal(wrun("cd bench/pi-lock && npm ci"), "pass");
  assert.equal(wrun("npm install --package-lock-only --ignore-scripts"), "pass");
  assert.equal(wrun(`npm ci --prefix=${fwd(path.win32.join(WOWNED, "bench", "pi-lock"))}`), "pass");
  assert.equal(wrun("npm install --package-lock-only", path.win32.join(WOWNED, "bench", "pi-lock")), "pass");
  assert.equal(wrun(`npm ci --prefix=${fwd(toLong(path.win32.join(WOWNED, "bench", "pi-lock")))}`, toLong(WOWNED)), "pass", "long spelling from a long cwd");
});

// as for the root itself (child-install-owned-root-win32 expected-deny R9): the pre-allow takes the long spelling, the child-block guard then denies
test("expected-deny (R9): win32 child in the short root: npm ci --prefix=<long spelling>/bench/pi-lock passes the pre-allow, then '*.worktrees/*' denies", () => {
  const d = checkToolCall(wrules, "bash", { command: `npm ci --prefix=${fwd(toLong(path.win32.join(WOWNED, "bench", "pi-lock")))}` }, wctx());
  assert.equal(d?.kind, "deny");
  assert.match(d!.reason, /'\*\.worktrees\/\*'/);
});

test("(decision: deny) win32 child: cd through a symlink out of the root or to a sibling (cd guard)", () => {
  assert.equal(wrun("cd esc && npm ci"), "deny");
  assert.equal(wrun("cd ../other && npm ci"), "deny");
});

test("(decision: ask) win32 child: a symlink out of the root, a prefix outside it", () => {
  assert.equal(wrun(`npm ci --prefix=${fwd(path.win32.join(WLINK, "x"))}`), "ask");
  assert.equal(wrun("npm ci", WLINK), "ask");
  assert.equal(wrun(`npm ci --prefix=${fwd(WOTHER)}`), "ask");
  assert.equal(wrun(`npm ci --prefix=${fwd(path.win32.join(SHORT_BASE, "ws.worktrees", "r1x"))}`), "ask");
  assert.equal(wrun("cd bench/pi-lock && FOO=1 npm ci"), "ask");
});
