// r9 P1b (Windows CI id 122): on the runner the owned worktree root lies below os.tmpdir() in its 8.3 spelling
// (`C:\Users\RUNNER~1\AppData\Local\Temp\...\ws.worktrees\r1`), and `npm ci --prefix=C:/Users/RUNNER~1/.../ws.worktrees/r1` asked:
// the `~` of the short name made the prefix unsafe, and the compare knew one spelling only. On win32 a `~` inside a name (after a
// letter or digit) is literal, and the prefix and the root are also compared in their native-realpath spelling (8.3 expanded),
// that one only when no symlink is on the prefix's way (a symlink is no 8.3 alias). Never wider than the owned root.
// Simulated win32 (injected platform, path.win32 world, no file system); each test is named by its literal line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const SHORT_BASE = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-child-own-install-x";
const toLong = (p: string): string => p.replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, "C:\\Users\\runneradmin");
const fwd = (p: string): string => p.replace(/\\/g, "/");
const OWNED = path.win32.join(SHORT_BASE, "ws.worktrees", "r1");
const OTHER = path.win32.join(SHORT_BASE, "other");
const LINK = path.win32.join(SHORT_BASE, "ws.worktrees", "r1link");
const wHome = path.win32.join(SHORT_BASE, "home");
const rules = buildOverlayRules(baseline, {}, {}, path.win32.join(wHome, ".pi", "agent"), path.win32.join(SHORT_BASE, "ws"), undefined, false);
// the JS realpath keeps the short name (identity, with the link resolved); the native one expands it
const viaLink = (p: string): string => (p.toLowerCase() === LINK.toLowerCase() || p.toLowerCase().startsWith(LINK.toLowerCase() + "\\") ? OTHER + p.slice(LINK.length) : p);
const ctx = (cwd = OWNED, roundRoots = [OWNED]): MatchCtx => ({ cwd, home: wHome, platform: "win32", role: "child", install: true, roundRoots, exists: () => true, isDir: () => true, realpath: (p) => viaLink(path.win32.resolve(p)), realpathNative: (p) => toLong(viaLink(path.win32.resolve(p))), list: () => [] });
const decide = (command: string, c: MatchCtx = ctx()) => checkToolCall(rules, "bash", { command }, c);
const run = (command: string, c: MatchCtx = ctx()): string => decide(command, c)?.kind ?? "pass";

test("win32 child in C:\\Users\\RUNNER~1\\...\\ws.worktrees\\r1: npm ci --prefix=C:/Users/RUNNER~1/.../ws.worktrees/r1 passes (short spelling, id 122)", () => {
  assert.equal(run(`npm ci --prefix=${fwd(OWNED)}`), "pass");
  assert.equal(run(`npm install --prefix ${fwd(OWNED)}`), "pass");
});

// The owned-root pre-allow takes the long spelling (the decision is past the 'ask'), but the child-block guard's in-workspace exemption
// compares one spelling, so '*.worktrees/*' denies it. Left closed on purpose (a deny guard is not loosened for this); recorded here.
test("expected-deny (R9): win32 child in C:\\Users\\RUNNER~1\\...\\ws.worktrees\\r1: npm ci --prefix=C:/Users/runneradmin/.../ws.worktrees/r1 (long spelling) passes the pre-allow, then '*.worktrees/*' denies", () => {
  const d = decide(`npm ci --prefix=${fwd(toLong(OWNED))}`);
  assert.equal(d?.kind, "deny");
  assert.match(d!.reason, /'\*\.worktrees\/\*'/);
});

test("expected-deny (R9): win32 child, root bound long, cwd long: npm ci --prefix=C:/Users/RUNNER~1/.../ws.worktrees/r1 (short prefix of a long root) passes the pre-allow, then '*.worktrees/*' denies", () => {
  const L = toLong(OWNED);
  const d = decide(`npm ci --prefix=${fwd(OWNED)}`, ctx(L, [L]));
  assert.equal(d?.kind, "deny");
  assert.match(d!.reason, /'\*\.worktrees\/\*'/);
});

test("win32 child, root bound long, cwd long: npm ci --prefix=C:/Users/runneradmin/.../ws.worktrees/r1 passes (long spelling of a long root)", () => {
  const L = toLong(OWNED);
  assert.equal(run(`npm ci --prefix=${fwd(L)}`, ctx(L, [L])), "pass");
});

test("win32 tokenCandidates: node build.js --out=C:/Users/RUNNER~1/.../ws.worktrees/r1/dist in the owned root is no '*.worktrees/*' deny (the drive colon after = is no <rev>:<path> split)", () => {
  const d = decide(`node build.js --out=${fwd(path.win32.join(OWNED, "dist"))}`);
  assert.ok(!d || !/'\*\.worktrees\/\*'/.test(d.reason), d?.reason);
});

test("win32 tokenCandidates: node build.js --out=C:/Users/RUNNER~1/.../ws.worktrees/r2/dist (a sibling worktree) stays denied by '*.worktrees/*'", () => {
  const d = decide(`node build.js --out=${fwd(path.win32.join(SHORT_BASE, "ws.worktrees", "r2", "dist"))}`);
  assert.equal(d?.kind, "deny");
  assert.match(d!.reason, /'\*\.worktrees\/\*'/);
});

test("win32 child: plain npm ci and npm ci --prefix . in the owned root pass", () => {
  assert.equal(run("npm ci"), "pass");
  assert.equal(run("npm ci --prefix ."), "pass");
});

test("win32 child: npm ci --prefix=C:/Users/RUNNER~1/.../other asks (foreign prefix, either spelling)", () => {
  assert.equal(run(`npm ci --prefix=${fwd(OTHER)}`), "ask");
  assert.equal(run(`npm ci --prefix=${fwd(toLong(OTHER))}`), "ask");
  assert.equal(run(`npm ci --prefix=${fwd(path.win32.join(OWNED, "sub"))}`), "pass"); // R10 item 6 (ruling D2): a subdir of the owned root is pre-allowed
  assert.equal(run("npm ci --prefix=D:/elsewhere"), "ask");
});

test("win32 child: npm ci --prefix=C:/Users/RUNNER~1/.../ws.worktrees/r1link with r1link -> other asks (a symlink is no 8.3 alias)", () => {
  assert.equal(run(`npm ci --prefix=${fwd(LINK)}`), "ask");
  assert.equal(run(`npm ci --prefix=${fwd(toLong(LINK))}`), "ask");
});

test("win32 child: a ~ that bash would expand stays unsafe: npm ci --prefix=~/r1 and --prefix=C:/~x ask", () => {
  assert.equal(run("npm ci --prefix=~/r1"), "ask");
  assert.equal(run("npm ci --prefix=C:/~x"), "ask");
});

// `env -i` is a wrapper option that variants() strips without a trace; npmInstallOwned never sees it, so an ask does not fit there.
test("expected-open (R9): win32 child: env -i npm ci in the owned root passes (wrapper options are stripped before the pre-allow)", () => {
  assert.equal(run("env -i npm ci"), "pass");
});

test("win32 child: npm ci in a cwd that is not the owned root asks, whatever the prefix", () => {
  assert.equal(run(`npm ci --prefix=${fwd(OWNED)}`, ctx(OTHER)), "ask");
});
