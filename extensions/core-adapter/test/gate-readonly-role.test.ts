// Guard round 1, step 1: a reviewer or explorer in a round (`roots.roundReadOnly`) never writes the worktree it inspects. The gate refuses the writes it can name
// (`child-readonly-write`, a child deny no rule, judge verdict or mode lifts); test runs, reads and its scratch dir stay allowed. Every refused row has an allowed
// row beside it. The rows marked "open" assert the verdict of today for a write the gate cannot name (see docs/safety.md, read-only roles).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { shellWriteTargets } from "../defaults.ts";
import { parseShell } from "../shellast.ts";
import type { GateRoots } from "../pathrules.ts";
import { isolationDir } from "../roundsurface.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup, cached per module with no seam; PI_OFFLINE makes
// that lookup return early, so the spawn guard of the test run sees no npm
process.env.PI_OFFLINE = "1";

type T = Parameters<typeof r11Rig>[0];
const fwd = (p: string): string => p.replace(/\\/g, "/");
const base = fs.realpathSync(mkTestTmp("pf-ro-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "sub"), scr, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
const W = fwd(wt);
const S = fwd(scr);

const roots = (role: string, readOnly: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: true, role, tmpAccess: false, ...(readOnly ? { roundReadOnly: true } : {}) });
type Verdict = { block?: boolean; rule?: string; allow?: boolean; reason?: string } | undefined;
const verdict = (tool: string, input: Record<string, unknown>, role = "reviewer", readOnly = true): Verdict => {
  const cwd = wt;
  return gateEvaluate(tool, input, cwd, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots(role, readOnly) }).result as Verdict;
};
const bash = (command: string, role?: string, readOnly?: boolean): Verdict => verdict("bash", { command }, role, readOnly);
const RO = "child-readonly-write";
const refused = (v: Verdict): boolean => !!v?.block && v.rule === RO;

const REFUSED = [
  "echo x > f", "echo x >> tracked", 'echo "$X" > f', "echo x >| f", "env A=1 touch f", "nohup touch f", "sed -i s/a/b/ f", "touch f", "rm f", "cp a b", "mv a b", "mkdir d",
  "cat a | tee f", "npm test > out.txt", "npm test && touch f", "cd sub && touch f", "cd sub && rm -rf .", "cd sub && cp a .", "xargs touch f", "bash -c 'touch f'",
  "tar -xf a.tar -C sub", "git commit -m x", "git add .", "git reset --hard", "git checkout -- f", "git stash", "git tag v1", "git config user.name x",
  `git -C ${W} -C . commit -m x`, "tar -xf a.tar", "git fetch origin main:main", `git clone . ${S}/c`, `echo x > ${W}/abs.txt`,
];
const ALLOWED = [
  "git status", "git log", "git diff", "git branch --list", "git config --get x", "git fetch origin", "npm test", "npm run lint", "node --test x.test.ts", "make test", "make", "make -C sub test",
  "npm --prefix sub test", "cargo test --target-dir target", `cd ${S} && git clone ${W} c`, "npm run test:node", "npm run typecheck", "npm run check", "npm ci", "python3 -m pytest",
  `node ${S}/p.mjs`, `tar -xf a.tar -C ${S}`, `unzip a.zip -d ${S}`, `echo x > ${S}/f`, `cp a ${S}/b`, `npm test > ${S}/out.txt`, "cat f > /dev/null", "ls 2>&1", "pnpm -C sub test",
  `git -C ${S}/c commit -m x`, `echo x > ${fwd(handoff)}/result.md`,
];

for (const role of ["reviewer", "explorer"]) {
  test(`${role}: a write the gate can name into the worktree is child-readonly-write`, () => {
    for (const l of REFUSED) assert.ok(refused(bash(l, role)), `${l} -> ${JSON.stringify(bash(l, role))}`);
  });

  test(`${role}: reads, test runs, its scratch dir and its handoff files are not child-readonly-write`, () => {
    for (const l of ALLOWED) assert.ok(!refused(bash(l, role)), `${l} -> ${JSON.stringify(bash(l, role))}`);
  });

  test(`${role}: path tools write into the worktree refused, read and the scratch dir not`, () => {
    for (const [tool, input] of [["write", { path: `${W}/a.ts`, content: "x" }], ["edit", { path: `${W}/a.ts`, edits: [] }], ["write", { path: "rel.ts", content: "x" }], ["foreman_move", { src: `${W}/a`, dst: `${S}/a` }], ["foreman_move", { src: `${S}/a`, dst: `${W}/a` }], ["foreman_copy", { src: `${S}/a`, dst: `${W}/b` }]] as const) assert.ok(refused(verdict(tool, { ...input }, role)), `${tool} ${JSON.stringify(input)}`);
    for (const [tool, input] of [["read", { path: `${W}/a.ts` }], ["foreman_copy", { src: `${W}/a`, dst: `${S}/b` }], ["write", { path: `${S}/a.md`, content: "x" }], ["write", { path: `${fwd(handoff)}/result.md`, content: "x" }], ["ls", { path: W }]] as const) assert.ok(!refused(verdict(tool, { ...input }, role)), `${tool} ${JSON.stringify(input)}`);
  });
}

// the step 0 helper: a target is named (an operand, a redirect, the directory of `tar -C`) or the catch-all "somewhere under this folder" (the tag is never read from the word `.`)
test("shellWriteTargets tags a named target and the catch-all of build tools, package managers, git and tar without a directory", () => {
  const norm = (p: string): string => (process.platform === "win32" ? fwd(p).toLowerCase() : fwd(p));
  const targets = (line: string): string[] => shellWriteTargets(parseShell(line, { cwd: wt, platform: process.platform, env: {} }), process.platform).map((x) => `${norm(x.path)} ${x.named ? "named" : "any"}`);
  const at = (rel: string, tag: string): string => `${norm(path.join(wt, rel))} ${tag}`;
  assert.deepEqual(targets("rm -rf ."), [at("", "named")]);
  assert.deepEqual(targets("cp a ."), [at("", "named")]);
  assert.deepEqual(targets("echo x > f"), [at("f", "named")]);
  assert.deepEqual(targets('echo "$X" > f'), [at("f", "named")]);
  assert.deepEqual(targets("npm test"), [at("", "any")]);
  assert.deepEqual(targets("git commit -m x"), [at("", "any")]);
  assert.deepEqual(targets("tar -xf a.tar"), [at("", "any")]);
  assert.deepEqual(targets("tar -xf a.tar -C sub"), [at("sub", "named"), at("", "any")]);
  for (const l of ["npm --prefix sub test", "pnpm -C sub test", "git -C sub commit -m x"]) assert.deepEqual(targets(l), [at("sub", "any")], l);
  for (const l of ["make -C sub test", "make --directory sub test"]) assert.deepEqual(targets(l), [at("sub", "any"), at("", "any")], l);
  // a target the gate cannot resolve is skipped
  assert.deepEqual(targets('cd "$X" && touch f'), []);
});

test("open, verdict of today: a write the gate has no target for is not child-readonly-write", () => {
  // `chmod` and a write after `cd "$X"` (refused by child-write-outside, not by this fence) name no target the write-target code reads (docs/safety.md); `find -delete` is refused since step 3a
  for (const l of ["chmod +x a", 'cd "$X" && touch f']) assert.ok(!refused(bash(l)), `${l} -> ${JSON.stringify(bash(l))}`);
});

test("the directory forms the docs name (unzip -d, patch -d, dd of=, perl -i) are refused in the worktree and allowed in the scratch dir", () => {
  for (const l of ["unzip a.zip -d sub", "patch -d sub -i p.diff", "dd if=a of=f", "perl -pi -e s/a/b/ f"]) assert.ok(refused(bash(l)), `${l} -> ${JSON.stringify(bash(l))}`);
  for (const l of [`patch -d ${S} -i p.diff`, `dd if=a of=${S}/f`, `perl -pi -e s/a/b/ ${S}/f`]) assert.ok(!refused(bash(l)), `${l} -> ${JSON.stringify(bash(l))}`);
});

test("a builder is unchanged: no row is child-readonly-write, and a write in its worktree stays what it was", () => {
  for (const l of REFUSED) assert.ok(!refused(bash(l, "builder", false)), l);
  for (const [tool, input] of [["write", { path: `${W}/a.ts`, content: "x" }], ["foreman_move", { src: `${W}/a`, dst: `${W}/b` }]] as const) assert.ok(!refused(verdict(tool, { ...input }, "builder", false)), tool);
  // the same call at the base commit: a builder's touch in its worktree is a plain write-in
  assert.equal(bash("touch f", "builder", false)?.block, undefined);
});

// --- the flag and the fence in the full rig -------------------------------------------------------------------------------------------------------------
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });
const ROLES = ["explorer", "builder", "reviewer"];
const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } };

async function rig(t: T, role: string, mode: string, registerRound: (c: Awaited<ReturnType<typeof r11Rig>>) => string | null, cwd?: (c: { project: string }) => string) {
  let judged = 0;
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { judged++; return { content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  const perms = { mode, allow: ["Bash(*)", "Write", "Edit"] };
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role, launchId: "l1", kind: "first", workspace: "", perms: { mode, childDeny: true } } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const c = await r11Rig(t, {}, { ctx: { modelRegistry: registry, [RIG_PERMISSIONS]: perms }, config, child: true });
  const manifest = registerRound(c);
  const state = path.join(c.agentDir, "pi-foreman", "state", "sessions", "parent-session");
  if (manifest !== null) {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "manifest.json"), manifest);
  }
  if (cwd) (c.ctx as { cwd: string }).cwd = cwd(c);
  return { c, judged: () => judged };
}
const roundOf = (path_: string): string => JSON.stringify({ entries: [{ path: path_, kind: "worktree" }] });
const writeRow = async (c: { call: (t: string, i: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>; project: string }) => c.call("write", { path: path.join(c.project, "a.txt"), content: "x" });

for (const mode of ["auto", "allow"]) {
  test(`nothing lifts it: mode ${mode}, allow rules Bash, Write, Edit and an allow-everything classifier`, async (t: T) => {
    const { c, judged } = await rig(t, "reviewer", mode, (r) => roundOf(r.project));
    for (const [tool, input] of [["write", { path: path.join(c.project, "a.txt"), content: "x" }], ["bash", { command: "echo x > f" }], ["bash", { command: "git commit -m x" }], ["edit", { path: path.join(c.project, "a.txt"), edits: [] }]] as const) {
      const res = await c.call(tool, { ...input });
      assert.ok(res?.block, `${tool} ${JSON.stringify(input)}`);
      assert.match(String(res.reason), /child-readonly-write/);
    }
    assert.equal(judged(), 0, "the classifier is not called");
    // beside it: a read and a scratch write are not refused by this fence
    const rd = await c.call("read", { path: path.join(c.project, "a.txt") });
    assert.ok(!/child-readonly-write/.test(String(rd?.reason)));
  });
}

test("the flag: reviewer and explorer in a round are read-only, a builder is not", async (t: T) => {
  const r = await rig(t, "reviewer", "auto", (c) => roundOf(c.project));
  assert.match(String((await writeRow(r.c))?.reason), /child-readonly-write/);
  const e = await rig(t, "explorer", "auto", (c) => roundOf(c.project));
  assert.match(String((await writeRow(e.c))?.reason), /child-readonly-write/);
  const b = await rig(t, "builder", "auto", (c) => roundOf(c.project));
  assert.ok(!/child-readonly-write/.test(String((await writeRow(b.c))?.reason)));
});

test("the flag: no round registered, an unreadable manifest, or a reviewer outside every round: no flag", async (t: T) => {
  const none = await rig(t, "builder", "auto", () => null);
  assert.ok(!/child-readonly-write/.test(String((await writeRow(none.c))?.reason)));
  const bad = await rig(t, "builder", "auto", () => "{ not json");
  assert.ok(!/child-readonly-write/.test(String((await writeRow(bad.c))?.reason)));
  const rv = await rig(t, "reviewer", "auto", () => null);
  assert.ok(!/child-readonly-write/.test(String((await writeRow(rv.c))?.reason)));
  const other = await rig(t, "reviewer", "auto", (c) => roundOf(path.join(c.project, "..", "elsewhere")));
  assert.ok(!/child-readonly-write/.test(String((await writeRow(other.c))?.reason)));
});

test("the flag: a child in its own isolation worktree has none, a write into the round worktree stays child-write-outside", async (t: T) => {
  let round = "";
  let iso = "";
  const r = await rig(
    t,
    "reviewer",
    "auto",
    (c) => {
      round = path.join(c.project, "..", "round");
      iso = path.join(isolationDir(round), "round");
      for (const d of [round, iso]) {
        fs.mkdirSync(d, { recursive: true });
        execFileSync("git", ["init", "-q", d]);
      }
      return roundOf(round);
    },
    () => iso,
  );
  const own = await r.c.call("write", { path: path.join(iso, "a.txt"), content: "x" });
  assert.ok(!/child-readonly-write/.test(String(own?.reason)), "its own isolation worktree");
  const out = await r.c.call("write", { path: path.join(round, "a.txt"), content: "x" });
  assert.match(String(out?.reason), /child-write-outside/);
});

// list-mode `git branch` forms are reads: the fence does not count the catch-all, so a read-only role gets the verdict it gets without the flag
const BRANCH_READS = [
  "git branch --contains HEAD", "git branch --merged", "git branch --no-merged main", "git branch -r --contains HEAD", "git branch --sort=-committerdate", "git branch -l", "git branch --points-at HEAD",
  "git branch --format=%(refname)", "git branch --sort -committerdate", "git branch -l 'feat*'", "git branch --no-contains HEAD", "git -C sub branch --merged",
];
const BRANCH_WRITES = ["git branch new", "git branch -d x", "git branch -m a b", "git branch --contains HEAD -d x", "git branch -f main HEAD", "git branch --merged > f", "git branch --contains HEAD new", "git branch -c a b", "git branch -u origin/main"];
test("a git catch-all refusal says the git command changes the round worktree's repository and names the scratch clone; a named target keeps its path text", () => {
  const v = bash("git commit -m x");
  assert.ok(refused(v), JSON.stringify(v));
  assert.match(String(v?.reason), /a git command changes the repository of the round worktree .*, which is read-only for your role/);
  assert.doesNotMatch(String(v?.reason), /is inside/);
  assert.match(String(v?.reason), /git clone/);
  assert.match(String(bash("echo x > f")?.reason), /is inside/);
});

for (const role of ["reviewer", "explorer"]) {
  test(`${role}: list-mode git branch forms keep the verdict they have without the flag, branch writes stay refused`, () => {
    for (const l of BRANCH_READS) {
      assert.ok(!refused(bash(l, role)), `${l} -> ${JSON.stringify(bash(l, role))}`);
      assert.deepEqual(bash(l, role, true), bash(l, role, false), l);
    }
    for (const l of BRANCH_WRITES) assert.ok(refused(bash(l, role)), `${l} -> ${JSON.stringify(bash(l, role))}`);
  });
}
