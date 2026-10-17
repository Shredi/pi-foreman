// R10 P1 item 2 (b): `{cwd}/.pi/scratch` and everything below are readable with read-only verbs for the foreman and its children ({cwd} = the
// session's own cwd; a child's is its worktree), through the ownTasks shape (absolute + realpath spellings). The rest of `{cwd}/.pi/*`, the
// childDeny `*/.pi/settings.json` and every write there stay protected. `.pi/scratch` lies inside the workspace: the permission system's
// external_directory rules do not apply, and its bash rules allow `cat *`/`ls *`/`tail *`/`grep *` (asserted below).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownTaskReadable, piScratchReadable } from "../roundsurface.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-pis-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const scratch = path.join(ws, ".pi", "scratch");
for (const d of [scratch, path.join(ws, ".pi", "other"), path.join(ws, ".git"), ag]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(scratch, "ci.log"), "error\n");
fs.writeFileSync(path.join(ws, ".pi", "settings.json"), "{}\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
// index.ts overlayBlock: the session's own bg_run task dirs and its `.pi/scratch`, for the session cwd and the workspace root
const ownTasks = [...ownTaskReadable([ws], "sess-own", process.platform), ...piScratchReadable([ws], process.platform)];
const ctx = (role: "main" | "child", own = ownTasks): MatchCtx => ({ cwd: ws, home, platform: process.platform, role, ownTasks: own });
const sh = (role: "main" | "child", command: string, own = ownTasks): string => checkToolCall(rules, "bash", { command }, ctx(role, own))?.kind ?? "pass";

const OPEN = ["ls .pi/scratch", "ls -la .pi/scratch/", "cat .pi/scratch/ci.log", "tail -n 50 .pi/scratch/ci.log", "head .pi/scratch/ci.log", "wc -l .pi/scratch/ci.log", "grep -n error .pi/scratch/ci.log", `cat ${path.join(scratch, "ci.log")}`];
for (const cmd of OPEN) {
  for (const role of ["main", "child"] as const) {
    test(`expected-open (R10b): ${cmd.replace(w, "<tmp>")} (overlay, ${role === "main" ? "foreman" : "child"})`, { skip: !posix }, () => {
      assert.equal(sh(role, cmd), "pass");
    });
  }
}

test("(decision: deny) without the .pi/scratch patterns a child's read was denied by '{cwd}/.pi/*' (the R9 dialog; the fix is the pattern)", { skip: !posix }, () => {
  assert.equal(sh("child", "cat .pi/scratch/ci.log", ownTaskReadable([ws], "sess-own", process.platform)), "deny");
});

test("(decision: deny) the rest of .pi stays protected for a child: settings.json (childDeny), another .pi dir, a prefix name", { skip: !posix }, () => {
  assert.equal(sh("child", "cat .pi/settings.json"), "deny");
  assert.equal(sh("child", "cat .pi/other/x"), "deny");
  assert.equal(sh("child", "ls .pi"), "deny");
  assert.equal(sh("child", "cat .pi/scratch2/x"), "deny");
});

test("(decision: ask/deny) writes into .pi/scratch stay protected for the foreman and a child", { skip: !posix }, () => {
  for (const role of ["main", "child"] as const) {
    for (const cmd of ["echo x > .pi/scratch/f", "cp README .pi/scratch/f", "rm .pi/scratch/ci.log", "touch .pi/scratch/f", "cat .pi/scratch/ci.log | tee .pi/scratch/g"]) {
      assert.notEqual(sh(role, cmd), "pass", `${role}: ${cmd}`);
    }
  }
});

test("(decision: deny) a symlink in .pi/scratch to a protected path, or a .. escape, stays protected for a child", { skip: !posix }, () => {
  fs.symlinkSync(path.join(ws, ".git"), path.join(scratch, "gitlink"));
  fs.symlinkSync(path.join(ws, ".pi", "settings.json"), path.join(scratch, "slink"));
  assert.equal(sh("child", "cat .pi/scratch/gitlink/config"), "deny");
  assert.equal(sh("child", "cat .pi/scratch/slink"), "deny");
  assert.equal(sh("child", "cat .pi/scratch/../settings.json"), "deny");
});

test("expected-open (R10b): cat .pi/scratch/ci.log from a cwd reached through a symlink (patterns for the cwd and its realpath, as index.ts builds them)", { skip: !posix }, () => {
  const link = path.join(w, "wslink");
  fs.symlinkSync(ws, link);
  const own = piScratchReadable([link, fs.realpathSync(link)], process.platform);
  const c: MatchCtx = { cwd: link, home, platform: process.platform, role: "child", ownTasks: own };
  assert.equal(checkToolCall(rules, "bash", { command: "cat .pi/scratch/ci.log" }, c)?.kind ?? "pass", "pass");
  assert.equal(checkToolCall(rules, "bash", { command: "cat .pi/settings.json" }, c)?.kind ?? "pass", "deny");
});

test("piScratchReadable: the dir and its subtree for each absolute root, nothing for a relative one", { skip: !posix }, () => {
  assert.deepEqual(piScratchReadable([ws, ws, "rel"], "linux"), [scratch, `${scratch}/*`]);
});

test("the permission system's bash rules allow the read verbs (no PS ask inside the workspace)", () => {
  const allow = (JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { bash: { allow: string[] } }).bash.allow;
  for (const r of ["ls *", "cat *", "tail *", "head *", "wc *", "grep *"]) assert.ok(allow.includes(r), r);
});
