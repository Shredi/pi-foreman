// guard-followup item 3 and the owner addendum: new `danger-git` cases (defaults.ts gitSeg): program-running options and verbs for both roles,
// ref-moving forms for subagents only, `git credential fill` for both roles.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { dangerMatch, lineDefault } from "../defaults.ts";
import type { DangerEnv, DefaultCtx, GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

const base = fs.realpathSync(mkTestTmp("pf-gfu-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false, ownBranches: () => [] };
const denv = (child: boolean): DangerEnv => ({ roots: roots(child), platform: process.platform, cwd: wt, facts });
const dctx = (): DefaultCtx => ({ roots: roots(false), facts, platform: process.platform, cwd: wt });
const segs = (line: string) => parseShell(line, { cwd: wt, env: { FOREMAN_SCRATCH: scr } });
const danger = (line: string, child: boolean): string | null => dangerMatch({ tool: "bash", input: { command: line }, text: line, segments: segs(line) }, denv(child))?.name ?? null;
const deflt = (line: string): string | null => lineDefault(line, segs(line), dctx());
const U = "https://example.com/r.git";

const BOTH = [
  // fetch and pull --upload-pack, spellings of the one rule
  "git fetch --upload-pack=./x origin", "git fetch --upload-pack ./x origin", "git fetch --upload-pa=./x origin", "git fetch --upl=./x origin", "git pull --upload-pack=./x", "git pull --upload-pack ./x origin main",
  // clone --upload-pack and -u
  `git clone -u ./x ${U}`, `git clone --upload-pack=./x ${U}`, `git clone --upload-pack ./x ${U}`, `git clone -u./x ${U}`, `git clone -nu ./x ${U}`, `git clone --u=./x ${U}`, `git clone ${U} -u ./x`,
  // push --receive-pack and --exec
  "git push --receive-pack=./x origin HEAD", "git push --receive-pack ./x origin HEAD", "git push --exec=./x origin HEAD", "git push --exec ./x origin HEAD", "git push --receive-p=./x origin HEAD", "git push --rec=./x origin HEAD", "git push --ex=./x origin HEAD",
  // the low-level push verbs, every form
  "git send-pack origin feature", "git send-pack --force origin main", `git http-push ${U} feature`, "git send-pack --exec=./x origin feature", "git http-push",
  // addendum: credential fill
  "git credential fill", "git -C src credential fill",
];

const BOTH_OUT = [
  "git fetch origin", "git fetch -u origin", "git fetch --all", "git pull", "git pull --rebase origin main", `git clone ${U}`, `git clone -b u ${U}`, `git clone -bu ${U}`, `git clone ${U} -- -u`, `git clone ${U} -- --upload-pack=./x`,
  `git clone -c user.name=x ${U}`, "git push origin HEAD", "git push -u origin round/x",
  "git credential approve", "git credential reject", "git credential",
  // D2: documented limits, no entry
  "git submodule foreach 'git push'", "git bisect run ./t.sh", "git difftool -x ./x", "git -c alias.p=push p", "git ls-remote --upload-pack=./x origin", `git clone --template=./t ${U}`,
];

const CHILD_ONLY = [
  "git switch -C main", "git switch --force-create main", "git checkout -B main", "git worktree add -B main ../wt",
  "git branch -f main HEAD", "git branch --force main HEAD", "git branch -m feature other", "git branch -M main", "git branch --move feature other", "git branch -C feature main", "git branch -fM main",
  "git update-ref refs/heads/main abc", "git update-ref -d refs/heads/main", "printf 'update refs/heads/main abc\\n' | git update-ref --stdin",
  "git reflog delete HEAD@{1}", "git prune", "git prune --expire=now", "git tag -d v1", "git tag --delete v1", "git worktree move a b",
];

const CHILD_OUT = [
  // A3: left out on purpose
  "git checkout f.txt", "git fetch origin +main:main", "git fetch origin main:main", "git branch -c feature main", "git branch --copy feature other", "git reset --keep HEAD~1",
  "git switch -f main", "git switch --force main", "git switch --discard-changes main", "git reset --merge HEAD~1", "git reset HEAD~1", "git rm -f f.txt", "git rm -r src", "git tag -f v1",
  "git worktree add ../wt", "git worktree add ../wt -b topic", "git worktree lock a", "git worktree unlock a", "git worktree repair", "git branch --set-upstream-to=origin/main", "git symbolic-ref HEAD refs/heads/main",
  // ordinary work
  "git switch -c topic", "git switch main", "git checkout main", "git checkout -b topic", "git branch topic", "git branch -a", "git branch --list", "git tag v1", "git tag -l", "git reflog", "git worktree list",
];

test("program-running options and verbs are danger-git for the main session and a subagent", () => {
  for (const l of BOTH) for (const child of [false, true]) assert.equal(danger(l, child), "danger-git", `${child ? "child" : "main"}: ${l}`);
});

test("the plain forms, the word after --, other options and the D2 limits stay out of the class", () => {
  for (const l of BOTH_OUT) for (const child of [false, true]) assert.equal(danger(l, child), null, `${child ? "child" : "main"}: ${l}`);
});

test("the ref-moving forms are danger-git for a subagent and stay out for the main session", () => {
  for (const l of CHILD_ONLY) {
    assert.equal(danger(l, true), "danger-git", `child: ${l}`);
    assert.equal(danger(l, false), null, `main: ${l}`);
  }
});

test("the lines of A3 and ordinary branch work stay out of the class for a subagent", () => {
  for (const l of CHILD_OUT) assert.equal(danger(l, true), null, `child: ${l}`);
});

test("git credential fill is danger-git for both roles; approve and reject are not", () => {
  for (const child of [false, true]) {
    assert.equal(danger("git credential fill", child), "danger-git");
    assert.equal(danger("git credential approve", child), null);
    assert.equal(danger("git credential reject", child), null);
  }
});

test("no built-in allow takes a dangerous line; fetch and own-branch push keep their defaults", () => {
  for (const l of BOTH) assert.equal(deflt(l), null, l);
  assert.equal(deflt("git fetch origin"), "default-git-fetch");
  assert.equal(deflt("git push origin round/x"), "default-git-push");
  assert.equal(danger("git fetch origin", true), null);
  assert.equal(danger("git push origin round/x", false), null);
});

test("floors keep precedence: a subagent's push and a protected push stay refused", () => {
  const fenv: FloorEnv = { cwd: wt, home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: [wt, scr], protectedBranches: ["release"], currentBranch: () => "round/x", remoteHead: () => "trunk" };
  const floor = (line: string, e: FloorEnv): string | null => lineFloors(line, segs(line), e)?.rule ?? null;
  for (const l of ["git push --receive-pack=./x origin HEAD", "git push --exec ./x origin round/x"]) {
    assert.equal(floor(l, { ...fenv, child: true }), "floor-git-push-child", l);
    assert.equal(floor(l, fenv), null, l);
  }
  assert.equal(floor("git push --receive-pack=./x origin main", fenv), "floor-git-push-protected");
  assert.equal(floor("git push --exec=./x origin release", { ...fenv, child: true }), "floor-git-push-child");
});

type T = Parameters<typeof r11Rig>[0];
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });
const ROLES = ["explorer", "builder", "reviewer"];
const E2E_BOTH = ["git fetch --upload-pack=./x origin", `git clone -u ./x ${U}`, "git send-pack origin feature", "git credential fill"];
const E2E_CHILD = ["git switch -C main", "git update-ref -d refs/heads/main", "git tag -d v1"];

for (const kind of ["main", "child"] as const) {
  for (const mode of ["auto", "allow"] as const) {
    test(`end to end: ${kind} in mode ${mode}: the class is judged in auto and runs as mode:allow:danger-git in allow`, async (t: T) => {
      const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
      t.after(() => {
        if (saved.b === undefined) delete process.env[BINDINGS_ENV]; else process.env[BINDINGS_ENV] = saved.b;
        if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT; else process.env.FOREMAN_CHECKOUT = saved.c;
      });
      if (kind === "child") process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode, childDeny: true } } });
      else delete process.env[BINDINGS_ENV];
      delete process.env.FOREMAN_CHECKOUT;
      let judged = 0;
      const modelRegistry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { judged++; return { content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
      const ui = { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
      const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } };
      const c = await r11Rig(t, {}, { ctx: { modelRegistry, ui, [RIG_PERMISSIONS]: { mode, allow: ["Write", "Edit"], classifier: { allow: ["Anything at all."] } } }, config, child: kind === "child" });
      const g = (...a: string[]) => execFileSync("git", ["-C", c.project, "-c", "user.name=p", "-c", "user.email=p@x", ...a], { stdio: "ignore" });
      g("init", "-q", "-b", "feature");
      fs.writeFileSync(path.join(c.project, "f.txt"), "x");
      g("add", "f.txt");
      g("commit", "-q", "-m", "init");
      g("branch", "main");
      if (kind === "child") process.env.FOREMAN_CHECKOUT = path.join(c.project, "..", "main");
      const run = async (command: string): Promise<{ judged: boolean; rule?: string }> => {
        const j0 = judged;
        const n0 = c.trace().length;
        await c.call("bash", { command });
        const recs = c.trace().slice(n0).filter((x) => x.event === "guard" && x.guard === "gate");
        return { judged: judged > j0, rule: (recs[recs.length - 1] as { rule?: string } | undefined)?.rule };
      };
      for (const l of kind === "child" ? [...E2E_BOTH, ...E2E_CHILD] : E2E_BOTH) {
        const r = await run(l);
        if (mode === "auto") assert.equal(r.judged, true, l);
        else assert.equal(r.rule, "mode:allow:danger-git", l);
      }
      if (kind === "main") {
        // a subagent-only line is not judged for the main session in auto
        const r = await run("git tag -d v1");
        assert.equal(r.judged, false);
        assert.notEqual(r.rule, "mode:allow:danger-git");
      }
    });
  }
}
