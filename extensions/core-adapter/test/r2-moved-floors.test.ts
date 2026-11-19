// Round 2, step 2 part A: the guarantees that lived only in the permission overlay now hold in the gate (floor-fs-scan, the /tmp scratch hint in the child
// write refusal, `.git` internals). Every test goes through gateDecide or the floor functions, never the overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, gateEvaluate, type GateResult } from "../gate.ts";
import { BUILTIN_DENY_INLINE, lineFloors, scanToolFloor, type FloorEnv } from "../floors.ts";
import { readBaseline } from "../baseline.ts";
import { parseShell } from "../shellast.ts";
import { GATE_DENY_PREFIXES } from "../gatedialog.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

// rows that build a bash line from a fixture path (the shell parser drops unquoted backslashes) or need the host's real case behaviour are posix-only; the win32 rows that set the platform run everywhere
import { posixOnly } from "./_platform.ts";
const base = fs.realpathSync.native(mkTestTmp("pf-r2-moved-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const work = path.join(base, "work");
const sub = path.join(work, "src");
const scr = path.join(base, "scr");
for (const d of [home, sub, scr, path.join(work, ".git", "hooks")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, ".git", "config"), "[core]\n");
fs.writeFileSync(path.join(home, "notes.txt"), "x\n");
const PKG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const mkRoots = (role: string, extra: object = {}) => ({ worktree: work, scratch: [scr], tmp: [fs.realpathSync.native(os.tmpdir()), "/tmp"], scratchBase: path.join(base, "scrbase"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: true, ...extra }) as never;
const envOf = (child: boolean, extra: Partial<FloorEnv> = {}): FloorEnv => ({ cwd: work, home, agentDir: path.join(home, ".pi", "agent"), writeRoots: [work, scr], scratch: [scr], pkgRoot: PKG_ROOT, child, ...extra });
const decide = (role: string, tool: string, input: Record<string, unknown>, extra: Partial<FloorEnv> = {}, rootsExtra: object = {}): GateResult =>
  gateDecide(tool, input, work, { env: () => envOf(role !== "foreman", extra), roots: () => mkRoots(role, rootsExtra) });
const rule = (r: GateResult): string | null => (r && "block" in r && r.block ? (r.rule ?? null) : null);
const ROLES = ["foreman", "builder", "reviewer", "explorer"];
const roleRoots = (role: string) => (role === "reviewer" || role === "explorer" ? { roundReadOnly: true } : {});
const run = (role: string, command: string): GateResult => decide(role, "bash", { command }, {}, roleRoots(role));

// ------------------------------------------------------------------ row 3: floor-fs-scan

const parent = path.dirname(work);
const SCANS = (root: string): string[] => [`find ${root} -name x`, `grep -rn x ${root}`, `grep -R x ${root}`, `rg x ${root}`, `fd x ${root}`, `du -sh ${root}`, `ls -R ${root}`, `tree ${root}`];

test("every scan program is refused on /, ~, the home dir and an ancestor of the workspace, for every role", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const root of ["/", "~", home, parent]) {
      for (const l of SCANS(root)) assert.equal(rule(run(role, l)), "floor-fs-scan", `${role}: ${l}`);
    }
  }
});

test("the refusal names the roots to read instead and carries a deny prefix", () => {
  const r = decide("builder", "bash", { command: "find / -name x" });
  assert.ok(r && "block" in r && r.block);
  assert.ok(GATE_DENY_PREFIXES.some((p) => r.reason.startsWith(p)), r.reason);
  assert.match(r.reason, /the worktree .*work/);
  assert.match(r.reason, /your scratch dir .*scr/);
  assert.match(r.reason, /\/tmp/);
  assert.match(r.reason, /bundled package roots/);
});

test("the bash -c and nested forms are refused too", () => {
  for (const l of ["bash -c 'find / -name x'", "sh -c \"grep -r x ~\"", "bash -c 'cd . && rg x /'", "env find / -name x", "echo hi | xargs find / -name x"]) {
    assert.equal(rule(run("builder", l)), "floor-fs-scan", l);
    assert.equal(rule(run("foreman", l)), "floor-fs-scan", l);
  }
});

test("a scan with no search root in the home dir is a scan of the home dir", () => {
  const e = envOf(false, { cwd: home });
  const f = (l: string) => lineFloors(l, parseShell(l, { cwd: home }), e)?.rule ?? null;
  assert.equal(f("find . -name x"), "floor-fs-scan");
  assert.equal(f("grep -r x"), "floor-fs-scan");
});

test("a scan of the workspace itself or a subfolder is not refused", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const l of ["find . -name x", `find ${work} -name x`, `grep -rn x ${sub}`, "rg x src", "fd x", `du -sh ${work}`, "ls -R", "tree src", `find ${scr} -name x`, `bash -c 'find ${sub} -name x'`]) {
      assert.notEqual(rule(run(role, l)), "floor-fs-scan", `${role}: ${l}`);
    }
  }
});

test("grep without -r on a file under home is not refused by this floor", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    assert.notEqual(rule(run(role, `grep x ${path.join(home, "notes.txt")}`)), "floor-fs-scan", role);
    assert.notEqual(rule(run(role, `grep -n x ~/notes.txt`)), "floor-fs-scan", role);
  }
});

// ------------------------------------------------------------------ row 21: a child's write to /tmp

test("a child's write to /tmp is refused with the scratch hint; a write into its scratch dir is not", { skip: posixOnly }, () => {
  for (const role of ["builder", "reviewer"]) {
    for (const [tool, input] of [["write", { path: "/tmp/x.txt", content: "x" }], ["bash", { command: "echo x > /tmp/x.txt" }]] as const) {
      const r = decide(role, tool, { ...input }, {}, roleRoots(role));
      assert.equal(rule(r), "child-write-outside", `${role} ${tool}`);
      assert.ok(r && "block" in r);
      assert.match(r.reason, new RegExp(`Use \\$FOREMAN_SCRATCH \\(${scr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\), not /tmp\\.`));
      assert.ok(GATE_DENY_PREFIXES.some((p) => r.reason.startsWith(p)));
    }
    for (const [tool, input] of [["write", { path: path.join(scr, "x.txt"), content: "x" }], ["bash", { command: `echo x > ${path.join(scr, "x.txt")}` }]] as const) {
      assert.notEqual(rule(decide(role, tool, { ...input }, {}, roleRoots(role))), "child-write-outside", `${role} ${tool}`);
    }
  }
});

test("a refusal outside /tmp carries no scratch hint", () => {
  const r = decide("builder", "bash", { command: "echo x > /etc/pf-x.txt" });
  assert.equal(rule(r), "child-write-outside");
  assert.ok(r && "block" in r && !/not \/tmp/.test(r.reason));
});

// ------------------------------------------------------------------ row 6: .git internals

test("a child's write into .git/hooks or .git/config is refused by the gate", { skip: posixOnly }, () => {
  for (const role of ["builder", "reviewer"]) {
    for (const p of [path.join(work, ".git", "hooks", "pre-commit"), path.join(work, ".git", "config")]) {
      for (const [tool, input] of [["write", { path: p, content: "x" }], ["edit", { path: p, edits: [] }], ["bash", { command: `echo x > ${p}` }]] as const) {
        const r = decide(role, tool, { ...input }, {}, roleRoots(role));
        assert.ok(r && "block" in r && r.block, `${role} ${tool} ${p}`);
      }
    }
  }
});

test("main: a write into .git/hooks is left to the judge, into .git/config it meets floor-secret-path (the gate's answers today)", { skip: posixOnly }, () => {
  for (const p of [path.join(work, ".git", "hooks", "pre-commit"), path.join(work, ".git", "config")]) {
    // no temp root: the fixture lives below the OS temp dir, whose writes are a built-in allow
    const w = decide("foreman", "write", { path: p, content: "x" }, {}, { tmp: [], tmpAccess: false });
    const b = decide("foreman", "bash", { command: `echo x > ${p}` }, {}, { tmp: [], tmpAccess: false });
    // recorded answers: .git/hooks gets no verdict (undefined: on to the judge and the mode step, never a built-in allow); .git/config is a secret path, floor-secret-path
    const want = p.endsWith("config") ? "floor-secret-path" : null;
    for (const r of [w, b]) {
      if (want) assert.equal(rule(r), want, JSON.stringify(r));
      else assert.equal(r, undefined);
    }
  }
});

// ------------------------------------------------------------------ row 3, revision: the find/grep tools, glob roots, win32 roots

const toolRun = (role: string, tool: string, input: Record<string, unknown>): GateResult => decide(role, tool, input, {}, roleRoots(role));

test("the find and grep tools: / ~ the home dir and an ancestor of the workspace are refused for every role", () => {
  for (const role of ROLES) {
    for (const root of ["/", "~", home, parent]) {
      assert.equal(rule(toolRun(role, "find", { path: root, pattern: "*.ts" })), "floor-fs-scan", `${role} find ${root}`);
      assert.equal(rule(toolRun(role, "grep", { path: root, pattern: "x" })), "floor-fs-scan", `${role} grep ${root}`);
    }
  }
});

test("the find and grep tools: the workspace, a subfolder, scratch and the default path are not refused by the scan floor", () => {
  for (const role of ROLES) {
    for (const tool of ["find", "grep"]) {
      for (const input of [{ path: work }, { path: sub }, { path: scr }, {}, { path: "." }, { path: "src" }]) {
        assert.notEqual(rule(toolRun(role, tool, { pattern: "x", ...input })), "floor-fs-scan", `${role} ${tool} ${JSON.stringify(input)}`);
      }
    }
  }
});

test("the find and grep tools: a default path in the home dir is a scan of the home dir; a single file under home is not refused by this floor", () => {
  const homeDecide = gateDecide("grep", { pattern: "x" }, home, { env: () => envOf(false, { cwd: home }), roots: () => mkRoots("foreman") });
  assert.equal(rule(homeDecide), "floor-fs-scan");
  for (const role of ROLES) {
    assert.notEqual(rule(toolRun(role, "grep", { path: path.join(home, "notes.txt"), pattern: "x" })), "floor-fs-scan", role);
  }
});

test("a glob root is expanded against the file system and every match is judged; a glob matching nothing risky gives no decision", { skip: posixOnly }, () => {
  const deep = path.join(home, "Documents", "git", "proj");
  fs.mkdirSync(path.join(deep, ".git"), { recursive: true });
  const inDeep = envOf(false, { cwd: deep, writeRoots: [deep, scr] });
  const f = (l: string, e: FloorEnv = envOf(false)) => lineFloors(l, parseShell(l, { cwd: e.cwd }), e)?.rule ?? null;
  for (const role of ROLES) {
    // /* expands to a folder that holds the home dir; `${base}/ho*` and `h?me` expand to the home dir itself
    for (const l of ["du -sh /*", "find /* -name x", `find ${base}/ho* -name x`, `grep -r x ${base}/h?me`, `find ${base}/[h]ome`]) {
      assert.equal(rule(run(role, l)), "floor-fs-scan", `${role}: ${l}`);
    }
    // matches that are the workspace, scratch or nothing
    for (const l of [`du -sh ${base}/wor*`, `find ${base}/sc* -name x`, `ls -R ${base}/no-such-*`, "du -sh /pf-no-such-dir*", `find ${work}/s*`]) {
      assert.notEqual(rule(run(role, l)), "floor-fs-scan", `${role}: ${l}`);
    }
  }
  // `~/D*` expands to an ancestor of the workspace; `/U*`-style roots through a folder below the root
  // the fixture lives below the OS temp dir, whose folders are allowed roots: point the temp dir elsewhere for these lines
  const tmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scr;
  try {
    assert.equal(f("find ~/D* -name x", inDeep), "floor-fs-scan");
    assert.equal(f(`find ${home}/Doc*/g* -name x`, inDeep), "floor-fs-scan");
    assert.equal(f(`find ${home}/Documents/git/pro* -name x`, inDeep), null);
  } finally {
    if (tmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpdir;
  }
  assert.equal(f(`find ${path.dirname(home)}/* -name x`, envOf(false)), "floor-fs-scan");
});

test("case: on darwin a differently cased home dir or ancestor is a scan of it; on linux it names another folder", { skip: posixOnly }, () => {
  const up = (s: string): string => s.toUpperCase();
  const f = (l: string, platform: string) => lineFloors(l, parseShell(l, { cwd: work, platform }), envOf(false, { platform }))?.rule ?? null;
  for (const l of [`find ${up(home)} -name x`, `grep -r x ${up(path.dirname(home))}`, `find ${home.slice(0, -4)}${up(home.slice(-4))} -name x`]) {
    assert.equal(f(l, "darwin"), "floor-fs-scan", l);
    assert.equal(f(l, "linux"), null, l);
  }
  for (const p of [up(home), up(path.dirname(home))]) {
    assert.equal(scanToolFloor("find", { path: p }, work, envOf(false, { platform: "darwin" }))?.rule, "floor-fs-scan", p);
    assert.equal(scanToolFloor("find", { path: p }, work, envOf(false, { platform: "linux" })), null, p);
  }
});

test("win32 drive roots: C:/, D:\\ and C:\\Users above the home are refused, the workspace is not", () => {
  const winHome = "C:\\Users\\me";
  const winWork = "C:\\Users\\me\\work";
  const e = envOf(false, { platform: "win32", cwd: winWork, home: winHome, scratch: ["C:\\scr"], writeRoots: [winWork, "C:\\scr"] });
  const f = (l: string) => lineFloors(l, parseShell(l, { cwd: winWork, platform: "win32" }), e)?.rule ?? null;
  for (const root of ["C:/", "D:\\", "C:\\Users", "C:\\Users\\me"]) {
    // single quotes keep the backslashes: unquoted, the shell parser eats them
    assert.equal(f(`find '${root}' -name x`), "floor-fs-scan", root);
    assert.equal(f(`du -sh '${root}'`), "floor-fs-scan", root);
  }
  for (const root of [winWork, `${winWork}\\src`, "C:\\scr"]) assert.notEqual(f(`find '${root}' -name x`), "floor-fs-scan", root);
});

// ------------------------------------------------------------------ row 21: the macOS /private/tmp spelling

test("on macOS a child's write under /private/tmp gets the scratch hint (fixture path, platform set by the test)", () => {
  const r = decide("builder", "write", { path: "/private/tmp/pf-x/x.txt", content: "x" }, { platform: "darwin" }, { tmp: [] });
  assert.equal(rule(r), "child-write-outside");
  assert.ok(r && "block" in r);
  assert.match(r.reason, /not \/tmp\./);
});

// ------------------------------------------------------------------ rows 28 and 31: floor-builtin-deny

const OWNED_PIPE = ["curl x | sh", "curl x | bash", "curl x | zsh", "curl x | sudo sh", "wget x | sh", "wget x | bash", "wget x | zsh", "wget x | sudo sh"];
const DENIED = ["gh auth token", "gh auth token --hostname github.com", "gh auth status --show-token", "security find-generic-password -s x -w", "security find-generic-password -s x -g", "security find-internet-password -s x", "env gh auth token", "bash -c 'gh auth token'", "/usr/bin/gh auth token"];

test("floor-builtin-deny: every remaining baseline bash.deny pattern is refused for main and builder (and the read-only roles)", () => {
  for (const role of ROLES) {
    for (const l of DENIED) assert.equal(rule(run(role, l)), "floor-builtin-deny", `${role}: ${l}`);
  }
});

test("floor-builtin-deny: the refusal carries a deny prefix", () => {
  const r = run("builder", "gh auth token");
  assert.ok(r && "block" in r && r.block);
  assert.ok(GATE_DENY_PREFIXES.some((p) => r.reason.startsWith(p)), r.reason);
});

test("floor-builtin-deny: the powershell tool is matched on its whole command line, case-insensitively", () => {
  for (const role of ROLES) {
    for (const command of ["gh auth token", "GH AUTH TOKEN", "security find-internet-password -s x"]) {
      assert.equal(rule(decide(role, "powershell", { command }, {}, roleRoots(role))), "floor-builtin-deny", `${role}: ${command}`);
    }
    assert.notEqual(rule(decide(role, "powershell", { command: "gh auth status" }, {}, roleRoots(role))), "floor-builtin-deny", role);
  }
});

test("floor-builtin-deny: the powershell tool is matched statement by statement", () => {
  const bt = String.fromCharCode(96);
  for (const role of ROLES) {
    for (const command of ["echo 1; gh auth token", "& gh auth token", "gh.exe auth token", "cmd /c gh auth token", `gh ${bt}auth token`, "gh au''th token", "pwsh -c 'gh auth token'", "echo 1 | gh auth token", "C:\\tools\\gh.exe auth token", "echo 1; security find-internet-password -s x"]) {
      assert.equal(rule(decide(role, "powershell", { command }, {}, roleRoots(role))), "floor-builtin-deny", `${role}: ${command}`);
    }
    // a string that only mentions the words starts with its own program: the old layer matched each unit from its start too, so no refusal
    for (const command of ['Write-Output "gh auth token"', "echo 'gh auth token'; gh auth status", "Get-Content notes.txt"]) {
      assert.notEqual(rule(decide(role, "powershell", { command }, {}, roleRoots(role))), "floor-builtin-deny", `${role}: ${command}`);
    }
  }
});

test("floor-builtin-deny: the powershell tool sees a continuation, a script block, parentheses and a cast", () => {
  const bt = String.fromCharCode(96);
  const denied = [`gh auth ${bt}\n token`, `gh ${bt}\nauth token`, `gh ${bt}\r\nauth token`, "& { gh auth token }", "{ gh auth token }.Invoke()", "if ($true) { gh auth token }", "foreach ($x in 1) { gh auth token }", "[string](gh auth token)"];
  const ordinary = ["Get-ChildItem . -Recurse | Where-Object { $_.Name -like '*.ts' }", "@{ a = 1 }", "echo 'a & b'", "git commit -m 'fix: & gh auth token docs'", 'Write-Output "gh auth token"', "Write-Host '{ gh auth token }'", "Select-String -Pattern 'gh auth token' f.txt"];
  for (const role of ["foreman", "builder"]) {
    for (const command of denied) assert.equal(rule(decide(role, "powershell", { command }, {}, roleRoots(role))), "floor-builtin-deny", `${role}: ${JSON.stringify(command)}`);
    for (const command of ordinary) assert.notEqual(rule(decide(role, "powershell", { command }, {}, roleRoots(role))), "floor-builtin-deny", `${role}: ${command}`);
  }
});

test("floor-builtin-deny: near misses are not refused by this floor", () => {
  for (const role of ROLES) {
    for (const l of ["gh auth status", "gh pr view", "gh auth login", "security find-certificate -a", "security find-generic-password -s x", "echo gh auth token"]) {
      assert.notEqual(rule(run(role, l)), "floor-builtin-deny", `${role}: ${l}`);
    }
  }
});

test("sudo and doas stay with floor-privilege", () => {
  for (const l of ["sudo ls", "doas ls"]) for (const role of ["foreman", "builder"]) assert.equal(rule(run(role, l)), "floor-privilege", `${role}: ${l}`);
});

test("the pipe-into-shell patterns stay with floor-download-shell (one row per pattern)", () => {
  for (const l of OWNED_PIPE) for (const role of ["foreman", "builder"]) {
    const r = rule(run(role, l));
    assert.notEqual(r, "floor-builtin-deny", `${role}: ${l}`);
    assert.equal(r, "floor-download-shell", `${role}: ${l}`);
  }
});

test("git credential fill is the danger-git label the judge decides, not this floor", () => {
  for (const role of ["foreman", "builder"]) {
    const out = gateEvaluate("bash", { command: "git credential fill" }, work, { env: () => envOf(role !== "foreman"), roots: () => mkRoots(role) });
    assert.notEqual(rule(out.result), "floor-builtin-deny", role);
    assert.equal(out.danger?.name, "danger-git", role);
  }
});

test("floor-builtin-deny: an unreadable baseline file still refuses, with the inline copy", () => {
  const nowhere = path.join(base, "no-such-package-root");
  for (const role of ["foreman", "builder"]) {
    for (const l of DENIED) {
      const r = decide(role, "bash", { command: l }, { pkgRoot: nowhere });
      assert.equal(rule(r), "floor-builtin-deny", `${role}: ${l}`);
    }
    assert.notEqual(rule(decide(role, "bash", { command: "gh auth status" }, { pkgRoot: nowhere })), "floor-builtin-deny");
  }
});

test("floor-builtin-deny: the powershell tool sees a statement after a closing brace or parenthesis and across backtick escapes", () => {
  const bt = String.fromCharCode(96);
  const T = "gh auth token";
  const denied = [
    `if ($true) { echo 1 }; ${T}`, `& { echo 1 }; ${T}`, `(echo 1); ${T}`, `$x = (1); ${T}`, `Get-Date | % { $_ } | Out-Null; ${T}`,
    "Get-ChildItem | Where-Object { $_.Length -gt 0 } ; security find-internet-password -s x", `(1) | ${T}`, `(1) && ${T}`,
    `echo ${bt}'; ${T}`, `echo ${bt}"; ${T}`, `echo a${bt}'b ; ${T}`, `Write-Host "a${bt}"b"; ${T}`, `echo "${bt}$("; ${T}`, `echo ${bt}${bt} ; ${T}`, `echo ${bt}{ ; ${T}`,
  ];
  for (const role of ["foreman", "builder"]) {
    for (const command of denied) assert.equal(rule(decide(role, "powershell", { command }, {}, roleRoots(role))), "floor-builtin-deny", `${role}: ${JSON.stringify(command)}`);
  }
});

test("the inline copy of bash.deny equals the baseline file's list", () => {
  assert.deepEqual([...BUILTIN_DENY_INLINE], readBaseline(PKG_ROOT)?.bash.deny);
});
