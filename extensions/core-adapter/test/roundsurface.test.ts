// Ledger items 7c, 7e: round surfaces (own handoff dir, round worktrees from the manifest, bound ledger), the
// foreman's round worktree add, an isolation worktree as a child's own root.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { effectCtx } from "../effects.ts";
import { applyLedgerItems, reviewLedgerBlock } from "../ledgerblock.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { isolationDir, roundRoots, roundWorktreeAdd, roundWorktrees } from "../roundsurface.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const rules = bashRules(baseline, {});
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-round-")));
after(async () => {
  await waitQuiet(path.join(base, "state"));
  rmTestTmp(base);
});
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const iso = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-1");
const handoff = path.join(base, "agent", "pi-foreman", "handoffs", "20260101-000000-demo");
for (const d of [path.join(main, ".git"), path.join(main, ".workflow", "scratch"), path.join(rt, ".workflow", "scratch"), path.join(iso, "src"), handoff]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(rt, ".git"), "gitdir: x\n");
fs.writeFileSync(path.join(iso, ".git"), "gitdir: y\n");
fs.writeFileSync(path.join(main, ".workflow", "LEDGER-topic.md"), "- [ ] 1. thing\n");
fs.writeFileSync(path.join(main, ".workflow", "scratch", "plan-x.md"), "plan\n");
fs.writeFileSync(path.join(rt, ".workflow", "scratch", "p.md"), "p\n");
fs.writeFileSync(path.join(iso, "src", "a.ts"), "a\n");
const ledger = path.join(main, ".workflow", "LEDGER-topic.md");

test("roundWorktrees: only the session's own unremoved worktree entries of the manifest", () => {
  const state = path.join(base, "state");
  fs.mkdirSync(path.join(state, "sessions", "S1"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "sessions", "S1", "manifest.json"),
    JSON.stringify({ v: 1, entries: [{ path: "/repo.worktrees/round", kind: "worktree", owner: "S1" }, { path: "/repo.worktrees/gone", kind: "worktree", owner: "S1", removed: 1 }, { path: "/repo.worktrees/kid", kind: "worktree", owner: "launch-9" }, { path: "/x/scratch/t", kind: "scratch", owner: "S1" }] }),
  );
  if (posix) assert.deepEqual(roundWorktrees(state, "S1"), ["/repo.worktrees/round"]);
  assert.deepEqual(roundWorktrees(state, "S2"), []);
  assert.deepEqual(roundWorktrees(state, "../S1"), []);
  if (posix) assert.deepEqual(roundRoots(["/repo.worktrees/round"], "/repo.worktrees/round/src"), ["/repo.worktrees/round"]);
  if (posix) assert.equal(isolationDir("/repo.worktrees/round"), "/repo.worktrees/worktrees/round");
});

test("roundWorktreeAdd: the foreman's add of <repo>.worktrees/<round>, nothing else", { skip: !posix }, () => {
  const top = (d: string): string | null => (d.startsWith("/repo") ? "/repo" : null);
  const add = (cmd: string, cwd = "/repo"): string | null => roundWorktreeAdd(cmd, cwd, "linux", top);
  assert.equal(add("git worktree add ../repo.worktrees/round -b round main"), "/repo.worktrees/round");
  assert.equal(add("git -C /repo worktree add ../repo.worktrees/round -b round main", "/repo.worktrees/other"), "/repo.worktrees/round");
  assert.equal(add("git -C /repo worktree add /repo.worktrees/round"), "/repo.worktrees/round");
  for (const no of [
    "git worktree add ../elsewhere -b round main",
    "git worktree add ../repo.worktrees/a/b",
    "git worktree add ../repo.worktrees/round && rm -rf x",
    "git worktree add ../repo.worktrees/round > /tmp/x",
    "git worktree add --force ../repo.worktrees/round",
    "git worktree add ../repo.worktrees/../x",
    "git worktree add $HOME/repo.worktrees/round",
    "git worktree add ../repo.worktrees/round -b round main extra",
    "git worktree remove ../repo.worktrees/round",
  ]) assert.equal(add(no), null, no);
});

test("the link: the foreman's round worktree add needs no ask, a child's does not get it, other adds are not allowed", { skip: !posix }, async () => {
  const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
  const r = new ForemanReview();
  const s: ReviewSession = { isChild: false, cwd: main, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules, ownDirs: () => [handoff] };
  r.upsert("s", s);
  const line = `git -C ${main} worktree add ../repo.worktrees/round -b round main`;
  assert.deepEqual(await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value: line }), { kind: "allow" });
  assert.notEqual((await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value: `git -C ${main} worktree add /tmp/elsewhere -b round main` })).kind, "allow");
  assert.notEqual((await r.authorize("s", { requestId: "r", surface: "bash", agentName: "builder", forwarding: true, value: line })).kind, "allow");
});

test("7e line: mkdir -p <round wt>/.workflow/scratch && cp .workflow/scratch/plan-x.md <round wt>/.workflow/scratch/ by the foreman", { skip: !posix }, () => {
  const line = `mkdir -p ${rt}/.workflow/scratch && cp .workflow/scratch/plan-x.md ${rt}/.workflow/scratch/`;
  const allow = (own: string[]): string | null => deterministicAllow(rules, line, { effects: effectCtx(main), ownDirs: own });
  assert.equal(allow([handoff, rt]), "own-handoff");
  assert.notEqual(allow([handoff]), "own-handoff");
});

test("7c lines: a child in the round worktree reads the bound ledger by path and by glob, nothing else of main", { skip: !posix }, () => {
  const allow = (cmd: string, led: string | null = ledger): string | null => {
    const effects = effectCtx(rt, [], process.platform, led ? [led] : []);
    return deterministicAllow(rules, cmd, { effects, ownDirs: [handoff, rt], ...(led ? { ledger: led } : {}) });
  };
  assert.ok(allow(`cat ${ledger}`));
  assert.ok(allow(`cat ${main}/.workflow/LEDGER-*.md`));
  assert.ok(allow(`cat ${main}/.workflow/LEDGER-topic.md | head -40`));
  assert.equal(allow(`cat ${main}/.workflow/LEDGER-topic.md`, null), null);
  assert.equal(allow(`cat ${main}/.workflow/LEDGER-*.md`, null), null);
  assert.equal(allow(`cat ${main}/.workflow/scratch/plan-x.md`), null);
  assert.equal(allow(`cat ${main}/other/LEDGER-*.md`), null);
  assert.equal(allow(`cp x ${main}/.workflow/LEDGER-*.md`), null);
  assert.equal(allow(`rm ${ledger}`), null);
  // the round worktree is writable for a child's cp/mkdir as an owned dir
  assert.equal(allow(`mkdir -p ${rt}/.workflow/scratch/t && cp ${ledger} ${rt}/.workflow/scratch/t/l.md`), "own-handoff");
});

test("the link: a forwarded child ask reading the ledger resolves to the deterministic allow", { skip: !posix }, async () => {
  const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
  const r = new ForemanReview();
  const s: ReviewSession = { isChild: false, cwd: rt, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules, ownDirs: () => [handoff, rt], ledgerFile: () => ledger };
  r.upsert("s", s);
  for (const value of [`cat ${ledger}`, `cat ${main}/.workflow/LEDGER-*.md`]) assert.deepEqual(await r.authorize("s", { requestId: "r", surface: "bash", agentName: "builder", forwarding: true, value }), { kind: "allow" }, value);
});

test("overlay: the round worktrees and isolation worktrees of the session are every child's own root; siblings stay closed", { skip: !posix }, () => {
  const agent = path.join(base, "agent");
  const r = buildOverlayRules(baseline, {}, {}, agent, pkgRoot, undefined, false);
  const sibling = path.join(base, "repo.worktrees", "other", "f.txt");
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, "x");
  const call = (cwd: string, tool: string, p: string, roots?: string[]): string => checkToolCall(r, tool, { path: p }, { cwd, home: base, platform: process.platform, role: "child", ...(roots ? { roundRoots: roots } : {}) })?.kind ?? "pass";
  // a child's roots: the round worktree it sits in, or its own isolation worktree (never the isolation dir as a whole)
  const top = (d: string): string | null => (d.startsWith(iso) ? iso : null);
  const roots = roundRoots([rt], rt, process.platform, top);
  const isoRoots = roundRoots([rt], iso, process.platform, top);
  assert.deepEqual(roots, [rt]);
  assert.deepEqual(isoRoots, [iso]);
  // (a) the isolation child reads its own files; the round worktree is a root only for a child sitting in it
  assert.equal(call(iso, "read", path.join(rt, ".workflow", "scratch", "p.md")), "deny");
  assert.equal(call(iso, "read", path.join(rt, ".workflow", "scratch", "p.md"), isoRoots), "deny");
  assert.equal(call(iso, "read", path.join(iso, "src", "a.ts"), isoRoots), "pass");
  assert.equal(call(rt, "read", path.join(rt, ".workflow", "scratch", "p.md"), roots), "pass");
  // (b) the round-worktree child cannot reach the isolation worktrees under <round>
  assert.equal(call(rt, "read", path.join(iso, "src", "a.ts"), roots), "deny");
  assert.equal(call(rt, "ls", path.join(iso, "src"), roots), "deny");
  assert.equal(call(iso, "read", sibling, isoRoots), "deny");
  assert.equal(call(iso, "write", sibling, isoRoots), "deny");
  assert.equal(checkToolCall(r, "bash", { command: `cat ${rt}/.workflow/scratch/p.md` }, { cwd: rt, home: base, platform: process.platform, role: "child", roundRoots: roots }), null);
});

test("7c security: a child's sibling isolation worktree stays denied (path write, path read, bash redirect)", { skip: !posix }, () => {
  const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);
  const sib = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-2", "src", "a.ts");
  fs.mkdirSync(path.dirname(sib), { recursive: true });
  fs.writeFileSync(sib, "sibling\n");
  const top = (d: string): string | null => (d.startsWith(iso) ? iso : null);
  const roots = roundRoots([rt], iso, process.platform, top);
  const check = (tool: string, input: Record<string, unknown>, rs: string[] | undefined): string => checkToolCall(r, tool, input, { cwd: iso, home: base, platform: process.platform, role: "child", ...(rs ? { roundRoots: rs } : {}) })?.kind ?? "pass";
  assert.equal(check("write", { path: sib }, roots), "deny");
  assert.equal(check("read", { path: sib }, roots), "deny");
  assert.equal(check("bash", { command: `echo x > ${sib}` }, roots), "deny");
  assert.equal(check("bash", { command: `echo x > ${sib}` }, undefined), "deny");
});

test("7c security: a child's own isolation worktree is its root; the isolation dir and the round worktree are not", { skip: !posix }, () => {
  const top = (d: string): string | null => (d.startsWith(iso) ? iso : null);
  const isoDir = path.dirname(iso);
  assert.deepEqual(roundRoots([rt], iso, process.platform, top), [iso]);
  assert.deepEqual(roundRoots([rt], isoDir, process.platform, top), []);
  assert.deepEqual(roundRoots([rt], rt, process.platform, top), [rt]);
  assert.deepEqual(roundRoots([rt], path.join(base, "elsewhere"), process.platform, top), []);
  const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);
  const check = (tool: string, input: Record<string, unknown>): string => checkToolCall(r, tool, input, { cwd: iso, home: base, platform: process.platform, role: "child", roundRoots: roundRoots([rt], iso, process.platform, top) })?.kind ?? "pass";
  assert.equal(check("write", { path: path.join(iso, "src", "a.ts") }), "pass");
  assert.equal(check("read", { path: path.join(iso, "src", "a.ts") }), "pass");
});

test("7c security: a child in the round worktree cannot write into an isolation worktree under its round", { skip: !posix }, () => {
  const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);
  const top = (d: string): string | null => (d.startsWith(iso) ? iso : null);
  const check = (): string => checkToolCall(r, "bash", { command: `echo x > ${path.join(iso, "src", "a.ts")}` }, { cwd: rt, home: base, platform: process.platform, role: "child", roundRoots: roundRoots([rt], rt, process.platform, top) })?.kind ?? "pass";
  assert.equal(check(), "deny");
});

test("ledger block: a review task names the ledger file's absolute path", () => {
  assert.match(reviewLedgerBlock("- [ ] 1. a\n", "review", "/w/.workflow/LEDGER-t.md"), /Ledger file \(absolute path, readable from any directory\): \/w\/\.workflow\/LEDGER-t\.md/);
  assert.match(reviewLedgerBlock("- [ ] 1. a\n", "check item 1", "/w/.workflow/LEDGER-t.md"), /^\[pi-foreman ledger items\]/);
  assert.doesNotMatch(reviewLedgerBlock("- [ ] 1. a\n", "review"), /Ledger file/);
  const e = { agent: "reviewer", task: "review" };
  const b = { agent: "builder", task: "do item 1" };
  applyLedgerItems({ tasks: [e, b] }, "- [ ] 1. a\n", new Set(), "/w/.workflow/LEDGER-t.md");
  assert.match(e.task, /\/w\/\.workflow\/LEDGER-t\.md/);
  assert.doesNotMatch(b.task, /Ledger file/);
});
