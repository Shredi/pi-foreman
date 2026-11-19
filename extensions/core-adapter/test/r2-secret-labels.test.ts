// Round 2, step 2, row 16 D2: `~/.claude/.credentials.json` is a secret path for every session, reads included.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, gateEvaluate, type GateResult } from "../gate.ts";
import { pathFloors, secretPath, type FloorEnv } from "../floors.ts";
import { dangerSegment } from "../defaults.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-r2-secret-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const work = path.join(base, "work");
const scr = path.join(base, "scr");
for (const d of [home, work, scr, path.join(home, ".claude")]) fs.mkdirSync(d, { recursive: true });
const CRED = path.join(home, ".claude", ".credentials.json");

const roots = (role: string) => ({ worktree: work, scratch: [scr], tmp: [base, fs.realpathSync.native(os.tmpdir()), "/tmp"], scratchBase: path.join(base, "scrbase"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: true }) as never;
const envOf = (child: boolean): FloorEnv => ({ cwd: work, home, agentDir: path.join(home, ".pi", "agent"), writeRoots: [work, scr], scratch: [scr], child });
const decide = (role: string, tool: string, input: Record<string, unknown>): GateResult => gateDecide(tool, input, work, { env: () => envOf(role !== "foreman"), roots: () => roots(role) });
const rule = (r: GateResult): string | null => (r && "block" in r && r.block ? (r.rule ?? null) : null);
const ROLES = ["foreman", "builder", "reviewer"];

test("the read tool, cat and a write refuse the Claude credentials file for main, builder and reviewer", () => {
  for (const role of ROLES) {
    for (const p of [CRED, "~/.claude/.credentials.json"]) {
      assert.equal(rule(decide(role, "read", { path: p })), "floor-secret-path", `${role} read ${p}`);
      assert.equal(rule(decide(role, "bash", { command: `cat ${fwd(p)}` })), "floor-secret-path", `${role} cat ${p}`);
      assert.equal(rule(decide(role, "write", { path: p, content: "x" })), "floor-secret-path", `${role} write ${p}`);
      assert.equal(rule(decide(role, "bash", { command: `echo x > ${fwd(p)}` })), "floor-secret-path", `${role} redirect ${p}`);
    }
  }
});

test("win32 spellings of the file are a secret path", () => {
  const env: FloorEnv = { platform: "win32", cwd: "C:\\work\\repo", home: "C:\\Users\\me", agentDir: "C:\\Users\\me\\.pi\\agent" };
  for (const p of ["~/.claude/.credentials.json", "~\\.claude\\.credentials.json", "C:\\Users\\me\\.claude\\.credentials.json", "C:/Users/me/.claude/.credentials.json", "c:/users/ME/.CLAUDE/.Credentials.JSON"]) {
    assert.equal(pathFloors({ path: p }, env)?.rule, "floor-secret-path", p);
  }
});

test("near misses: other files of the folder and other dirs' dot-credentials files are not judged by the new name; `credentials.*` keeps what the old pattern does", () => {
  const env = envOf(false);
  // not matched by the new entry (nor by the old `credentials(\.[^/]*)?` pattern, which needs the name to start after a slash)
  for (const p of ["~/.claude/settings.json", "~/.claude/.credentials.json.md", "~/.claude/x.credentials.json", "src/.credentials.json", "~/other/.credentials.json"]) {
    assert.equal(secretPath(p, env), null, p);
  }
  // already judged before this change by the existing `credentials(\.[^/]*)?` pattern, unchanged
  for (const p of ["src/credentials.ts", "src/credentials.json.md"]) assert.notEqual(secretPath(p, env), null, p);
});

// ------------------------------------------------------------------ S3 and S5 labels (round 2, step 2, rows 16 and 24)
// both only ever stand in bash text, where unquoted backslashes of a native path are shell escapes
const fwd = (p: string): string => p.replace(/\\/g, "/");
const POLICY = fwd(path.join(home, ".pi", "agent", "pi-foreman", "permissions.json"));
const STATE = fwd(path.join(home, ".pi", "agent", "pi-foreman", "state", "approvals"));
const facts = { currentBranch: () => "feature/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const outcome = (role: string, line: string) => gateEvaluate("bash", { command: line }, work, { env: () => envOf(role !== "foreman"), roots: () => roots(role), facts });
const ROLES2 = ["foreman", "builder"];
/** The dangerous-class names of a line the gate left to the mode step (result undefined), or the floor rule / allow rule that answered. */
const answer = (role: string, line: string): string => {
  const o = outcome(role, line);
  const r = o.result;
  if (r && "block" in r && r.block) return `block ${r.rule}`;
  if (r && "allow" in r && r.allow) return `allow ${r.rule}`;
  return `undecided ${(o.dangers ?? []).join("+")}`;
};

// C: `danger-git-secret` left the judge-first list: a revision naming a secret file is a plain git read (a loosening, named in the plan's owner section); the text-match floors keep their answers
test("S3: a git revision naming a secret file carries no label in C: the default git read runs it (inside bash -c it is undecided), for main and builder", () => {
  for (const role of ROLES2) {
    for (const l of ["git show HEAD:.env", "git show :.env", "git show HEAD:.claude/.credentials.json"]) assert.equal(answer(role, l), "allow default-git-read", `${role} ${l}`);
    assert.equal(answer(role, "bash -c 'git show HEAD:.env'"), "undecided ", `${role} bash -c`);
    // names the floors' own text match already refuse keep that answer
    for (const l of ["git show HEAD:~/.ssh/id_rsa", "git cat-file -p HEAD:config/.env.production"]) assert.equal(answer(role, l), "block floor-secret-path", `${role} ${l}`);
  }
});

test("S3 controls: no label and the same decision as before for a source file, a bare revision, a format with a colon and a refspec", () => {
  for (const role of ROLES2) {
    for (const l of ["git show HEAD:src/a.ts", "git show HEAD", "git log --format=%h:%s"]) assert.equal(answer(role, l), "allow default-git-read", `${role} ${l}`);
    assert.equal(answer(role, "git fetch origin a:b"), "undecided ", `${role} fetch`);
  }
});

// C: `danger-harness-folder` left the judge-first list: such a segment carries no label
test("S5: a segment that is no known read and names a policy or state folder carries no label in C, for main and builder", () => {
  for (const role of ROLES2) {
    for (const l of [`git add ${POLICY}`, `git add ${STATE}`]) assert.equal(answer(role, l), role === "foreman" ? "allow default-git-add" : "undecided ", `${role} ${l}`);
  }
});

test("S5 controls: cat, grep and ls of the file are no label (a child's reads stay open), an unknown program without such a word is none, a write is still its floor", () => {
  for (const role of ROLES2) {
    for (const l of [`cat ${POLICY}`, `grep x ${POLICY}`, `ls ${STATE}`, "mytool a.txt"]) assert.ok(!answer(role, l).includes("danger-harness-folder"), `${role} ${l}`);
    for (const l of [`echo x > ${POLICY}`, `cp a.txt ${POLICY}`, `mytool ${POLICY}`, `mytool x > ${STATE}`]) assert.equal(answer(role, l), "block floor-policy-file", `${role} ${l}`);
  }
  assert.equal(answer("foreman", `cat ${POLICY}`), "allow default-read");
  assert.equal(answer("foreman", "mytool a.txt"), "undecided ");
});

test("S5 with or without the floor env in DangerEnv: no harness-folder label (C)", () => {
  const seg = parseShell(`git add ${POLICY}`, { cwd: work });
  const env = { roots: roots("foreman"), platform: process.platform, cwd: work, facts };
  assert.equal(dangerSegment(seg[0], env), null);
  assert.equal(dangerSegment(seg[0], { ...env, floor: envOf(false) }), null);
});

test("S5: an input redirect of a policy file carries no label in C, by an unknown program or a known reader", () => {
  const env = { roots: roots("foreman"), platform: process.platform, cwd: work, facts, floor: envOf(false) };
  assert.equal(dangerSegment(parseShell(`mytool < ${POLICY}`, { cwd: work })[0], env), null);
  assert.equal(dangerSegment(parseShell(`cat < ${POLICY}`, { cwd: work })[0], env), null);
  assert.equal(dangerSegment(parseShell("mytool < a.txt", { cwd: work })[0], env), null);
});
