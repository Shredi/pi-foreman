// Guard round 2, step 4: the `powershell` tool goes through the gate's path checks. psWords splits a line into words with no cmdlet knowledge; each resolved word is a
// WRITE target for the checks a bash write target gets (secret-path floor, `.git`, self-modification rules, install-root-write), never an allow; a read-only role
// gets no label of its own for a powershell line (the label `danger-readonly-run` is gone). Lines are data strings, never run.
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first: the git answers are in place before the adapter loads
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig } from "./_r11rig.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { psWords } from "../pswords.ts";
import { memoLookup, withLookupCache } from "../pathnorm.ts";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posix, posixOnly } from "./_platform.ts";

// C: no `danger-opaque` label: a powershell line carries no label of its own (judge-first kinds only), for every role
const base = fs.realpathSync(mkTestTmp("pf-r2-ps-"));
const home = path.join(base, "home");
const wt = path.join(base, "wt");
const scr = path.join(base, "scr");
const inst = path.join(base, "inst");
const pkg = path.join(base, "pkg");
const agentDir = path.join(home, ".pi", "agent");
for (const d of [path.join(agentDir, "extensions"), path.join(wt, ".git", "hooks"), path.join(wt, "sub"), scr, inst, pkg]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a.txt"), "x\n");
after(() => fs.rmSync(base, { recursive: true, force: true }));
/** A host path as bash text: unquoted backslashes of a native path are shell escapes there. */
const fwd = (p: string): string => p.replace(/\\/g, "/");

// ---------------------------------------------------------------- the word split

const none = (): null => null;
/** The words of `line` run in /w with home /h on a posix platform, no file system look-ups. */
const w = (line: string): string[] => psWords(line, "/w", "/h", "linux", none);
const bt = String.fromCharCode(96);

test("psWords: plain words are resolved against the cwd, the command word and parameters included (no cmdlet knowledge)", () => {
  assert.deepEqual(w("Set-Content a.txt x"), ["/w/Set-Content", "/w/a.txt", "/w/x"]);
  assert.deepEqual(w("Set-Content -Path a.txt -Value x"), ["/w/Set-Content", "/w/-Path", "/w/a.txt", "/w/-Value", "/w/x"]);
  assert.deepEqual(w("a a a"), ["/w/a"], "no repeats");
});

test("psWords: single and double quotes keep a word together; a doubled quote is one quote character", () => {
  assert.deepEqual(w(`Set-Content 'a b.txt' "c d"`), ["/w/Set-Content", "/w/a b.txt", "/w/c d"]);
  assert.deepEqual(w(`x 'it''s'`), ["/w/x", "/w/it's"]);
  assert.deepEqual(w(`x "say ""hi"""`), ["/w/x", '/w/say "hi"']);
  assert.deepEqual(w(`x 'a;b|c>d'`), ["/w/x", "/w/a;b|c>d"], "separators inside quotes stay in the word");
  assert.deepEqual(w(`x a'b c'd`), ["/w/x", "/w/ab cd"], "a quote in the middle of a word");
  assert.deepEqual(w(`x ""`), ["/w/x"], "an empty string is no word");
});

test("psWords: a backtick escapes the next character; in double quotes too; a backtick at a line end continues the line", () => {
  assert.deepEqual(w(`x a${bt}b`), ["/w/x", "/w/ab"]);
  assert.deepEqual(w(`x a${bt} b`), ["/w/x", "/w/a b"], "an escaped space stays in the word");
  assert.deepEqual(w(`x a${bt};b`), ["/w/x", "/w/a;b"], "an escaped separator stays in the word");
  assert.deepEqual(w(`x "a${bt}"b"`), ["/w/x", '/w/a"b']);
  assert.deepEqual(w(`x 'a${bt}b'`), ["/w/x", `/w/a${bt}b`], "no escape inside single quotes");
  assert.deepEqual(w(`x a${bt}\n b`), ["/w/x", "/w/a", "/w/b"]);
  assert.deepEqual(w(`x a${bt}\r\n b`), ["/w/x", "/w/a", "/w/b"]);
  assert.deepEqual(w(`x a${bt}`), ["/w/x", "/w/a"], "a trailing backtick");
});

test("psWords: each home spelling at the start of a word is the home folder, both separators, variable names in any case", () => {
  for (const spelling of ["~", "$HOME", "$home", "$Home", "$env:USERPROFILE", "$ENV:userprofile", "${env:USERPROFILE}", "${ENV:UserProfile}", "%USERPROFILE%", "%userprofile%"]) {
    assert.deepEqual(w(`x ${spelling}`), ["/w/x", "/h"], spelling);
    assert.deepEqual(w(`x ${spelling}/.ssh/k`), ["/w/x", "/h/.ssh/k"], spelling);
    assert.deepEqual(w(`x ${spelling}\\.ssh\\k`), ["/w/x", "/h/.ssh/k"], spelling);
    assert.deepEqual(w(`x "${spelling}\\.ssh\\k"`), ["/w/x", "/h/.ssh/k"], `"${spelling}"`);
    assert.deepEqual(w(`x -Path:${spelling}/f`), ["/w/x", "/h/f"], `-Path:${spelling}`);
  }
  assert.deepEqual(w(`x '~/f'`), ["/w/x", "/h/f"], "a single-quoted ~ is still the home folder for the provider");
});

test("psWords: a spelling that is not at the start of a word, or not a whole name, is a plain word", () => {
  assert.deepEqual(w("x $HOMEX/f"), ["/w/x", "/w/$HOMEX/f"]);
  assert.deepEqual(w("x a/~"), ["/w/x", "/w/a/~"]);
  assert.deepEqual(w("x ~root/f"), ["/w/x", "/w/~root/f"]);
  assert.deepEqual(w("x pre$HOME"), ["/w/x", "/w/pre$HOME"]);
  assert.deepEqual(w("x '$HOME/f'"), ["/w/x", "/w/$HOME/f"], "a single-quoted variable is not expanded");
  assert.deepEqual(w("x $env:USERPROFILEX"), ["/w/x", "/w/$env:USERPROFILEX"]);
});

test("psWords: statement and pipe separators, brackets, commas and every redirect operator end a word", () => {
  assert.deepEqual(w("a;b"), ["/w/a", "/w/b"]);
  assert.deepEqual(w("a|b"), ["/w/a", "/w/b"]);
  assert.deepEqual(w("a&b"), ["/w/a", "/w/b"]);
  assert.deepEqual(w("a&&b||c"), ["/w/a", "/w/b", "/w/c"]);
  assert.deepEqual(w("a\nb"), ["/w/a", "/w/b"]);
  assert.deepEqual(w("a,b"), ["/w/a", "/w/b"]);
  assert.deepEqual(w("& { a }"), ["/w/a"]);
  assert.deepEqual(w("(a)"), ["/w/a"]);
  assert.deepEqual(w("echo x>f"), ["/w/echo", "/w/x", "/w/f"]);
  assert.deepEqual(w("echo x>>f"), ["/w/echo", "/w/x", "/w/f"]);
  assert.deepEqual(w("echo x 2>f"), ["/w/echo", "/w/x", "/w/2", "/w/f"]);
  assert.deepEqual(w("echo x *>f"), ["/w/echo", "/w/x", "/w/*", "/w/f"]);
  assert.deepEqual(w("echo x 2>&1"), ["/w/echo", "/w/x", "/w/2", "/w/1"]);
  assert.deepEqual(w("cat <f"), ["/w/cat", "/w/f"]);
  assert.deepEqual(w("a > /h/b"), ["/w/a", "/h/b"]);
});

test("psWords: relative and absolute words, dot segments, both separators (off win32 a backslash is a separator too)", () => {
  assert.deepEqual(w("x /abs/f ./g ../h sub\\k sub/m\\n"), ["/w/x", "/abs/f", "/w/g", "/h", "/w/sub/k", "/w/sub/m/n"]);
  assert.deepEqual(w("x C:\\dir\\f"), ["/w/x", "/w/C:/dir/f"], "a drive path off win32 is a relative word");
});

// the words keep the case they were written in; the rows below compare them folded (the row after them checks the case)
const winCase = (line: string, cwd = "C:\\w"): string[] => psWords(line, cwd, "C:\\Users\\u", "win32", none);
const win = (line: string, cwd = "C:\\w"): string[] => [...new Set(winCase(line, cwd).map((s) => s.toLowerCase()))];

test("psWords on win32: both separators, case folded, home spellings, a UNC path, a drive-relative word", () => {
  assert.deepEqual(win("x a\\b/c"), ["c:\\w\\x", "c:\\w\\a\\b\\c"]);
  assert.deepEqual(win("x C:/Dir/F D:\\Other\\G"), ["c:\\w\\x", "c:\\dir\\f", "d:\\other\\g"]);
  assert.deepEqual(win("x ~/f $HOME\\f $env:USERPROFILE\\f ${env:USERPROFILE}/f %USERPROFILE%\\f"), ["c:\\w\\x", "c:\\users\\u\\f"]);
  assert.deepEqual(win("x $ENV:UserProfile\\.SSH\\id"), ["c:\\w\\x", "c:\\users\\u\\.ssh\\id"]);
  assert.deepEqual(win("x \\\\srv\\share\\dir\\f //srv/share/g"), ["c:\\w\\x", "\\\\srv\\share\\dir\\f", "\\\\srv\\share\\g"]);
  // a drive-relative word has a drive of its own: it resolves lexically on that drive, never against the cwd of another drive
  const rel = win("D:x");
  assert.equal(rel.length, 1);
  assert.match(rel[0], /^d:\\.*x$/);
  assert.ok(!rel[0].startsWith("c:"), rel[0]);
  assert.deepEqual(win("x ..\\..\\..\\up", "C:\\a\\b"), ["c:\\a\\b\\x", "c:\\up"], "dot segments stop at the drive root");
});

test("psWords on win32: a word keeps the case it was written in (the self-modification rules compare the agent folder by spelling)", () => {
  assert.deepEqual(winCase("x ~\\.pi\\agent\\Settings.json"), ["C:\\w\\x", "C:\\Users\\u\\.pi\\agent\\Settings.json"]);
  assert.deepEqual(winCase("x c:/Dir/F"), ["C:\\w\\x", "c:\\Dir\\F"]);
});

test("psWords: an empty line, a blank line and separators only have no words", () => {
  assert.deepEqual(w(""), []);
  assert.deepEqual(w("   \t\n  "), []);
  assert.deepEqual(w(" ; | & > < "), []);
  assert.deepEqual(w("''"), []);
});

test("psWords: the default resolver follows a link: a word spelled through a link to a folder is the real spelling", { skip: posixOnly }, () => {
  const link = path.join(base, "lnk");
  try {
    fs.symlinkSync(inst, link);
  } catch {
    return;
  }
  assert.deepEqual(psWords(`x ${link}/f`, wt, home, process.platform), [path.join(wt, "x"), path.join(inst, "f")]);
});

test("psWords: a very long line stays fast: 2,000 words in under a second, with the real resolver", () => {
  const line = Array.from({ length: 2000 }, (_, i) => `sub/f${i}.txt`).join(" ");
  const t0 = performance.now();
  const words = psWords(line, wt, home, process.platform);
  const ms = performance.now() - t0;
  assert.equal(words.length, 2000);
  assert.ok(ms < 1000, `${ms} ms`);
  // an unquoted line of one word and a quote that never closes are cheap and end
  assert.equal(psWords("x".repeat(100_000), wt, home, process.platform).length, 1);
  assert.equal(psWords(`x '${"y ".repeat(50_000)}`, wt, home, process.platform).length, 2);
});

// ---------------------------------------------------------------- the gate: the checks of (B)

type Role = "foreman" | "builder" | "reviewer" | "explorer";
const ROLES: Role[] = ["foreman", "builder", "reviewer", "explorer"];
const roots = (role: Role, extra: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [scr], tmp: [], owned: [], install: [inst, pkg], pkgRoot: pkg, roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: role === "foreman",
  agentDir, home, ...(role === "reviewer" || role === "explorer" ? { roundReadOnly: true } : {}), ...extra,
});
const outcome = (role: Role, line: string, tool = "powershell", extra: Partial<GateRoots> = {}, platform?: string) =>
  gateEvaluate(tool, { command: line }, wt, { env: (c) => baseFloorEnv(c, { home, agentDir, pkgRoot: pkg, child: role !== "foreman", ...(platform ? { platform } : {}) }), roots: () => roots(role, extra) });
const name = (r: GateResult): string => (!r ? "none" : "block" in r ? `block:${r.rule}` : "ask" in r ? `ask:${r.rule}` : `allow:${r.rule}`);
const ans = (role: Role, line: string, tool = "powershell", extra: Partial<GateRoots> = {}): string => name(outcome(role, line, tool, extra).result);
const dangers = (role: Role, line: string): string[] => outcome(role, line).dangers ?? [];

/** The answer of every role to `line`, in the order foreman, builder, reviewer, explorer. */
const four = (line: string): string[] => ROLES.map((r) => ans(r, line));

test("B: a secret path is refused for every role, as for a read: Set-Content, Add-Content, Out-File, a redirect", () => {
  for (const line of [`Set-Content ${home}/.ssh/id_rsa x`, `Add-Content ${home}/.npmrc x`, `"x" | Out-File ${home}/.aws/credentials`, `echo x > ${home}/.ssh/id_ed25519`, `Set-Content ${wt}/.env x`, `Set-Content .git/config x`]) {
    assert.deepEqual(four(line), Array(4).fill("block:floor-secret-path"), line);
  }
});

test("B: every home spelling reaches the secret-path floor, both separators", () => {
  for (const sp of ["~", "$HOME", "$env:USERPROFILE", "${env:USERPROFILE}", "%USERPROFILE%", "$home", "$ENV:userprofile"]) {
    for (const sep of ["/", "\\"]) assert.deepEqual(four(`Set-Content ${sp}${sep}.ssh${sep}id_rsa x`), Array(4).fill("block:floor-secret-path"), `${sp}${sep}`);
  }
  assert.deepEqual(four(`Set-Content "\${env:USERPROFILE}\\.aws\\credentials" x`), Array(4).fill("block:floor-secret-path"));
  assert.deepEqual(four(`Set-Content -Path:~/.ssh/id_rsa -Value x`), Array(4).fill("block:floor-secret-path"));
});

test("B: a word inside .git is what a bash write there gets: a child is refused (child-write-outside), main has no verdict; a word that only starts like it is free", () => {
  for (const line of ["Remove-Item .git/hooks/x", `Remove-Item ${wt}/.git/hooks/pre-commit`, "Set-Content .git/HEAD x", "Remove-Item -Force .git\\index", `Set-Content ${wt}/sub/../.git/HEAD x`, "git log -- .git"]) {
    assert.deepEqual(four(line), ["none", ...Array(3).fill("block:child-write-outside")], line);
  }
  for (const line of ["Set-Content .gitignore x", "Set-Content .github/x.yml y", "Set-Content sub/.gitkeep y"]) {
    for (const r of ROLES) assert.equal(ans(r, line), "none", `${r}: ${line}`);
  }
});

test("B: a word in the harness config folder or the agent extensions folder asks main and is denied for a child (the bash outcome)", () => {
  const settings = ["foreman", "builder", "reviewer", "explorer"].map((r) => (r === "foreman" ? "ask:selfmod-agent-settings" : "block:selfmod-agent-settings"));
  const harness = ["foreman", "builder", "reviewer", "explorer"].map((r) => (r === "foreman" ? "ask:selfmod-agent-harness" : "block:selfmod-agent-harness"));
  for (const line of [`Set-Content ${agentDir}/settings.json x`, `Set-Content ~/.pi/agent/settings.json x`, `Set-Content $HOME\\.pi\\agent\\settings.json x`, `& { Set-Content ${agentDir}/settings.json x }`]) assert.deepEqual(four(line), settings, line);
  for (const line of [`Set-Content ${agentDir}/extensions/x.ts x`, `Remove-Item $env:USERPROFILE\\.pi\\agent\\extensions\\x.ts`, `"x" > ${agentDir}/extensions/y.ts`]) assert.deepEqual(four(line), harness, line);
  // the same words as a bash write answer the same (the reference)
  assert.equal(ans("foreman", `echo x > ${fwd(agentDir)}/settings.json`, "bash"), settings[0]);
  assert.equal(ans("builder", `echo x > ${fwd(agentDir)}/extensions/x.ts`, "bash"), harness[1]);
});

test("B: a word in an install folder or a package folder is install-root-write: main is asked; a child is refused (the rig tests below check headless, mode deny and every child mode)", () => {
  for (const line of [`Set-Content ${inst}/x.js x`, `Remove-Item -Recurse ${inst}`, `Copy-Item a.txt ${pkg}/a.txt`, `Remove-Item ${pkg}/package.json`, `"x" | Out-File ${pkg}/y.txt`, `Set-Content -LiteralPath '${pkg}/z' x`, `Get-Content a.txt | Set-Content ${inst}/z`, `Set-Location ${pkg}; Set-Content x y`]) {
    assert.deepEqual(four(line), ["ask:install-root-write", "block:install-root-write", "block:install-root-write", "block:install-root-write"], line);
  }
});

test("B: the session's own worktree is exempt from install-root-write; a sibling under the same install root is not", () => {
  const under = { install: [base], pkgRoot: undefined };
  for (const r of ROLES) {
    assert.ok(!/install-root-write/.test(name(outcome(r, `Set-Content ${wt}/f x`, "powershell", under).result)), r);
    assert.ok(!/install-root-write/.test(name(outcome(r, `Set-Content a.txt x`, "powershell", under).result)), r);
  }
  assert.equal(name(outcome("foreman", `Set-Content ${inst}/f x`, "powershell", under).result), "ask:install-root-write");
  assert.equal(name(outcome("builder", `Set-Content ${inst}/f x`, "powershell", under).result), "block:install-root-write");
  // the bash line behaves the same (the reference)
  assert.ok(!/install-root-write/.test(name(outcome("foreman", `echo x > ${fwd(wt)}/f`, "bash", under).result)));
  assert.equal(name(outcome("foreman", `echo x > ${fwd(inst)}/f`, "bash", under).result), "ask:install-root-write");
});

test("B: the own ruling or brief file is refused by the check the old layer keeps (ruling.ts), for the powershell tool", { skip: posixOnly }, () => {
  const hand = path.join(base, ".workflow", "handoffs");
  const H = path.join(hand, "up");
  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(path.join(H, "parent"), "other\n");
  fs.writeFileSync(path.join(H, "child"), "me\n");
  const dirs = childHandoffDirs(hand, "me");
  for (const line of [`Set-Content ${H}/ruling.md x`, `Set-Content -Path ${H}\\ruling.md -Value x`, `"x" | Out-File '${H}/ruling.md'`, `Copy-Item x ${H}/brief-a.md`, `echo x > ${H}/ruling-1.md`]) {
    assert.equal(selfRulingRefusal("powershell", { command: line }, base, dirs), SELF_RULING_REASON, line);
  }
  assert.equal(selfRulingRefusal("powershell", { command: `Get-Content a.txt` }, base, dirs), undefined);
});

test("B: no word earns an allow: a path bash would call free (a read in the worktree, a write in scratch) is no allow for the powershell tool", () => {
  for (const line of ["Get-Content a.txt", "Set-Content a.txt x", `Set-Content ${scr}/ok.txt x`, `Copy-Item a.txt ${scr}/b.txt`, "Get-ChildItem", `Get-Content ${wt}/sub/../a.txt`]) {
    for (const r of ROLES) {
      const o = outcome(r, line);
      assert.equal(o.result, undefined, `${r}: ${line} -> ${name(o.result)}`);
      assert.deepEqual(o.dangers ?? [], [], `${r}: ${line}`);
    }
  }
  // the reference: bash decides the same read as a built-in allow
  assert.equal(ans("foreman", "cat a.txt", "bash"), "allow:default-read");
  assert.equal(ans("builder", "cat a.txt", "bash"), "allow:default-read");
  // an owner's allow rule is the owner's own: it is not a word's rule, and a refusal stays a refusal
  assert.equal(ans("foreman", `Set-Content ${home}/.ssh/id_rsa x`), "block:floor-secret-path");
});

test("B: a word never makes a verdict looser: the line floors still run on the line, and the powershell floors keep their rule names", () => {
  for (const r of ROLES) {
    assert.equal(ans(r, "gh auth token"), "block:floor-builtin-deny", r);
    assert.equal(ans(r, "echo 1; gh auth token"), "block:floor-builtin-deny", r);
  }
});

// ---------------------------------------------------------------- the label

test("C: no role gets a label on a plain powershell line (danger-opaque is gone), a read-only role included", () => {
  for (const line of ["Get-Content a.txt", "Set-Content a.txt x", `Set-Content ${scr}/ok.txt x`, "Get-ChildItem", "git status", "npm test", "Write-Output hi", "Get-Process", `Invoke-WebRequest https://example.com -OutFile x.bin`, ""]) {
    for (const r of ["reviewer", "explorer", "foreman", "builder"] as const) assert.deepEqual(dangers(r, line), [], `${r}: ${JSON.stringify(line)}`);
  }
});

test("C: a bash line of a read-only role carries no label", () => {
  assert.deepEqual(outcome("reviewer", "cat a.txt", "bash").dangers ?? [], []);
  assert.deepEqual(outcome("reviewer", "echo hello", "bash").dangers ?? [], []);
});

test("Get-Content a.txt in the worktree: no verdict of the gate and no label for every role", () => {
  for (const r of ROLES) {
    const o = outcome(r, "Get-Content a.txt");
    assert.equal(o.result, undefined, r);
    assert.deepEqual(o.dangers ?? [], [], r);
  }
});

test("a powershell line of a role that is not read-only is judged by words alone: a word outside the worktree gets no verdict and no label", () => {
  for (const line of ["Set-Content ../outside.txt x", "Set-Content /tmp/x x", "Set-Content C:\\Windows\\x x"]) {
    for (const r of ["foreman", "builder"] as const) {
      const o = outcome(r, line);
      assert.equal(o.result, undefined, `${r}: ${line}`);
      assert.deepEqual(o.dangers ?? [], [], `${r}: ${line}`);
    }
  }
});

// ---------------------------------------------------------------- win32

test("win32 platform: the checks run on win32 spellings (a short home spelling, a UNC word, both separators)", () => {
  const W = "C:\\wt";
  const winRoots: GateRoots = { worktree: W, scratch: ["C:\\scr"], tmp: [], owned: [], install: ["C:\\inst"], pkgRoot: "C:\\pkg", roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, agentDir: "C:\\Users\\u\\.pi\\agent", home: "C:\\Users\\u", realpath: () => null };
  const run = (line: string, child = false): string => {
    const r: GateRoots = child ? { ...winRoots, child: true, role: "builder", tmpAccess: false } : winRoots;
    return name(gateEvaluate("powershell", { command: line }, W, { env: (c) => baseFloorEnv(c, { home: "C:\\Users\\u", agentDir: r.agentDir, pkgRoot: "C:\\pkg", platform: "win32", child }), roots: () => r }).result);
  };
  assert.equal(run("Set-Content $env:USERPROFILE\\.ssh\\id_rsa x"), "block:floor-secret-path");
  assert.equal(run("Set-Content ~/.aws/credentials x"), "block:floor-secret-path");
  assert.equal(run("Set-Content C:\\INST\\x.js x"), "ask:install-root-write");
  assert.equal(run("Set-Content c:/inst/x.js x", true), "block:install-root-write");
  assert.equal(run("Set-Content C:\\wt\\f x"), "none");
  assert.equal(run("Remove-Item C:\\wt\\.GIT\\hooks\\x"), "none");
  assert.equal(run("Remove-Item C:\\wt\\.GIT\\hooks\\x", true), "block:child-write-outside");
  assert.equal(run("Set-Content C:\\wt\\.PI\\ext\\x.ts x"), "ask:selfmod-project-pi");
  assert.equal(run("Set-Content C:\\wt\\.pi\\scratch\\x y"), "none");
});

// ---------------------------------------------------------------- one adapter session

const text = (t: string) => ({ content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 1, output: 1 } });

async function rig(t: Parameters<typeof r11Rig>[0], o: { role?: "explorer" | "builder" | "main"; gate?: Record<string, unknown> } = {}) {
  const role = o.role ?? "explorer";
  const prev = process.env[BINDINGS_ENV];
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-ask-"));
  if (role === "main") delete process.env[BINDINGS_ENV];
  else process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role, launchId: "L1", kind: "first", model: null, askDir } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
    fs.rmSync(askDir, { recursive: true, force: true });
  });
  const prompts: string[] = [];
  const registry = {
    find: () => ({ id: "small" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: unknown, c: { systemPrompt: string }) => {
      prompts.push(c.systemPrompt);
      return text(JSON.stringify({ verdict: "clear", reason: "covered" }));
    },
  };
  const r = await r11Rig(t, {}, {
    child: role !== "main",
    deps: { spawner: inprocSpawner },
    ctx: { hasUI: false, mode: "json", modelRegistry: registry },
    config: { gate: { reviewTimeoutMs: 300, ...(o.gate ?? {}) }, providers: { fake: { review: { model: "small" }, roles: { explorer: { model: "fake/explorer" } } } } },
  });
  if (role === "explorer") {
    const dir = path.join(r.agentDir, "pi-foreman", "state", "sessions", "parent-s");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ entries: [{ path: r.project, kind: "worktree" }] }));
    await r.restart();
  }
  return { ...r, prompts, askDir };
}
test("C: main, a builder and a read-only child with a plain powershell line run it with no judge call (no allow-sentence route)", async (t) => {
  for (const role of ["main", "builder", "explorer"] as const) {
    const r = await rig(t, { role });
    const res = (await r.call("powershell", { command: "Get-Content a.txt" })) as { block?: boolean } | undefined;
    assert.ok(!res?.block, `${role}: ${JSON.stringify(res)}`);
    assert.equal(r.prompts.length, 0, `${role}: no judge call`);
  }
});

// ---------------------------------------------------------------- revision: .git and .pi words, `=` ends a word, the rig

const hand = path.join(agentDir, "pi-foreman", "handoffs", "h1");
const sess = path.join(agentDir, "sessions", "s");
for (const d of [path.join(hand, "work"), sess, path.join(wt, ".pi", "scratch"), path.join(wt, ".pi", "tasks")]) fs.mkdirSync(d, { recursive: true });
const handRoots: Partial<GateRoots> = { childHandoff: hand, ownHandoff: hand };

test("the child's own handoff files, a session folder file, .pi/scratch and .pi/tasks words are not refused for any role (the bash write outcome: no verdict, no label)", () => {
  for (const line of [`Set-Content ${hand}/result.md x`, `Get-Content ${hand}/plan.md`, `Set-Content ${hand}/work/x y`, `Add-Content ${hand}/ask.md x`, `Get-Content ${sess}/x.md`, "Set-Content .pi/scratch/x y", "Set-Content .pi/tasks/x y", "Get-ChildItem .pi/tasks"]) {
    for (const r of ROLES) {
      const o = outcome(r, line, "powershell", handRoots);
      assert.equal(o.result, undefined, `${r}: ${line} -> ${name(o.result)}`);
      assert.deepEqual(o.dangers ?? [], [], `${r}: ${line}`);
    }
  }
  // the bash write of the handoff files and of .pi/scratch is no verdict either (the reference)
  for (const line of [`echo x > ${fwd(hand)}/result.md`, `echo x > ${fwd(hand)}/plan.md`, `echo x > ${fwd(hand)}/work/x`]) {
    for (const r of ROLES) assert.equal(ans(r, line, "bash", handRoots), "none", `${r}: ${line}`);
  }
  for (const r of ["foreman", "builder"] as const) assert.equal(ans(r, "echo x > .pi/scratch/x", "bash", handRoots), "none", r);
});

test("a .pi word that is not a scratch or tasks path gets what a bash write there gets: the self-modification ask for main, the refusal for a child; no protected-folder-write", () => {
  // `.Pi` is the same folder only where the file system folds case (segmentAlias: not on linux); linux has its own row below
  for (const line of ["Set-Content .pi/ext/x y", "Get-Content .pi", ...(process.platform === "linux" ? [] : [`Set-Content ${wt}/.Pi/x y`])]) {
    assert.deepEqual(four(line), ["ask:selfmod-project-pi", ...Array(3).fill("block:selfmod-project-pi")], line);
  }
  assert.deepEqual(["foreman", "builder", "reviewer", "explorer"].map((r) => ans(r as Role, "echo x > .pi/ext/x", "bash")), ["ask:selfmod-project-pi", ...Array(3).fill("block:selfmod-project-pi")]);
});

test("a .Pi word is another folder than .pi on linux: no self-modification verdict for any role", { skip: process.platform !== "linux" }, () => {
  assert.deepEqual(four(`Set-Content ${wt}/.Pi/x y`), Array(4).fill("none"));
});

test(".git words: a bare .git, .git/config and .git/hooks/x get what a bash write target there gets, role by role", () => {
  // .git/config: the secret-path floor, for every role, bash and PowerShell
  for (const r of ROLES) {
    assert.equal(ans(r, "echo x > .git/config", "bash"), "block:floor-secret-path", r);
    assert.equal(ans(r, "Set-Content .git/config x"), "block:floor-secret-path", r);
    assert.equal(ans(r, "Get-Content .git/config"), "block:floor-secret-path", r);
  }
  // a bare .git and .git/hooks/x: main has no verdict, a child is refused with child-write-outside
  for (const [ps, sh] of [["Set-Content .git/hooks/x y", "echo x > .git/hooks/x"], ["Set-Content .git x", "echo x > .git"], ["git log -- .git", "echo x > .git"]]) {
    for (const r of ROLES) {
      const bashRef = ans(r, sh, "bash");
      assert.equal(ans(r, ps), bashRef, `${r}: ${ps}`);
      assert.equal(bashRef, r === "foreman" ? "none" : "block:child-write-outside", `${r}: ${sh}`);
    }
  }
});

test("win32: a ~\\.pi\\agent\\settings.json word gets the self-modification ask of main and the refusal of a child, as the bash write does", () => {
  const W = "C:\\wt";
  const winRoots: GateRoots = { worktree: W, scratch: ["C:\\scr"], tmp: [], owned: [], install: ["C:\\inst"], pkgRoot: "C:\\pkg", roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, agentDir: "C:\\Users\\u\\.pi\\agent", home: "C:\\Users\\u", realpath: () => null };
  const run = (tool: string, line: string, child: boolean): string => {
    const r: GateRoots = child ? { ...winRoots, child: true, role: "builder", tmpAccess: false } : winRoots;
    return name(gateEvaluate(tool, { command: line }, W, { env: (c) => baseFloorEnv(c, { home: "C:\\Users\\u", agentDir: r.agentDir, pkgRoot: "C:\\pkg", platform: "win32", child }), roots: () => r }).result);
  };
  for (const line of ["Set-Content ~\\.pi\\agent\\settings.json x", "Set-Content $env:USERPROFILE\\.pi\\agent\\settings.json x", "Set-Content ~/.pi/agent/settings.json x"]) {
    assert.equal(run("powershell", line, false), "ask:selfmod-agent-settings", line);
    assert.equal(run("powershell", line, true), "block:selfmod-agent-settings", line);
  }
  assert.equal(run("bash", "echo x > ~/.pi/agent/settings.json", false), "ask:selfmod-agent-settings");
  // a handoff-style word under the agent folder is no protected-folder-write
  assert.ok(!/protected-folder/.test(run("powershell", "Set-Content ~\\.pi\\agent\\pi-foreman\\handoffs\\h1\\result.md x", true)));
});

test("= ends a word: -Path=<folder>, $d='<folder>' and @{Path='<folder>/x'} reach the install-root-write check", () => {
  assert.deepEqual(w("Set-Content -Path=a.txt y"), ["/w/Set-Content", "/w/-Path", "/w/a.txt", "/w/y"]);
  assert.deepEqual(w("$d='/i/x'"), ["/w/$d", "/i/x"]);
  assert.deepEqual(w("@{Path='/i/x'}"), ["/w/@", "/w/Path", "/i/x"]);
  assert.deepEqual(w("a=~/f"), ["/w/a", "/h/f"]);
  assert.deepEqual(w("x 'a=b'"), ["/w/x", "/w/a=b"], "an = inside quotes stays in the word");
  const asked = ["ask:install-root-write", ...Array(3).fill("block:install-root-write")];
  for (const line of [`Set-Content -Path=${inst}/x y`, `$d='${inst}'; sc $d/x`, `@{Path='${inst}/x'}`, `$p=${pkg}/z`, `Set-Content -Path:${inst}/x y`]) assert.deepEqual(four(line), asked, line);
  assert.deepEqual(four(`Set-Content -Path=${home}/.ssh/id_rsa x`), Array(4).fill("block:floor-secret-path"));
});

test("psWords: a repeated word is resolved once and the answer does not change", () => {
  let calls = 0;
  const counting = (p: string): string | null => (calls++, null);
  assert.deepEqual(psWords("a a a a b b", "/w", "/h", "linux", counting), ["/w/a", "/w/b"]);
  const once = calls;
  calls = 0;
  psWords("a b", "/w", "/h", "linux", counting);
  assert.equal(calls, once);
});

test("withLookupCache is per call: a lookup made inside the scope is not served after it (also after a throw), and a link made between two powershell calls is seen by the second and by bash", (t) => {
  // the unit check: the look-up runs again once the scope has ended, and again after a scope left by an exception
  let looks = 0;
  const look = (): number => ++looks;
  assert.equal(withLookupCache(() => [memoLookup("k", look), memoLookup("k", look)]).join(), "1,1", "inside one scope a key is looked up once");
  assert.equal(memoLookup("k", look), 2, "after the scope the look-up runs again");
  assert.equal(memoLookup("k", look), 3, "and outside a scope nothing is remembered");
  assert.throws(() => withLookupCache(() => {
    memoLookup("k", look);
    memoLookup("k", look);
    throw new Error("boom");
  }), /boom/);
  assert.equal(memoLookup("k", look), 5, "after an exception inside the scope the cache is closed too");

  // the gate check: the same line before and after a link appears
  const line = `Set-Content ${wt}/new_x/x y`;
  for (const r of ROLES) assert.equal(ans(r, line), "none", `${r}: before the link`);
  try {
    fs.symlinkSync(inst, path.join(wt, "new_x"));
  } catch {
    t.skip("this platform cannot create symlinks here");
    return;
  }
  assert.equal(ans("foreman", line), "ask:install-root-write", "the second powershell call sees the link");
  assert.equal(ans("builder", line), "block:install-root-write");
  // a bash call on a path whose state changed after a powershell call is answered from the fresh state
  const fresh = path.join(wt, "new_z");
  assert.equal(ans("foreman", `Set-Content ${fresh}/x y`), "none");
  assert.equal(ans("builder", `echo x > ${fwd(fresh)}/x`, "bash"), "none");
  fs.symlinkSync(inst, fresh);
  assert.equal(ans("builder", `echo x > ${fwd(fresh)}/x`, "bash"), "block:child-write-outside", "bash after the powershell call: fresh state");
});

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pkgLine = `Set-Content ${PKG.replace(/\\/g, "/")}/extensions/core-adapter/no-such-file.ts x`;

async function mainUi(t: Parameters<typeof r11Rig>[0], o: { headless?: boolean } = {}) {
  const titles: string[] = [];
  const ui = { notify: () => undefined, confirm: async () => false, select: async (title: string) => (titles.push(title), "deny with comment"), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const c = await r11Rig(t, {}, { ctx: { ui, ...(o.headless ? { hasUI: false, mode: "print" } : {}) }, config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: {} } } } });
  return { ...c, titles };
}

test("rig: an install-folder word of the main session is refused when headless (no dialog); with a UI the owner is asked", async (t) => {
  const head = await mainUi(t, { headless: true });
  assert.equal(((await head.call("powershell", { command: pkgLine })) as { block?: boolean } | undefined)?.block, true);
  assert.equal(head.titles.length, 0);
  const auto = await mainUi(t);
  assert.equal(((await auto.call("powershell", { command: pkgLine })) as { block?: boolean } | undefined)?.block, true, "the owner's no refuses");
  assert.match(auto.titles[0] ?? "", /install-root-write/);
});

test("rig: an install-folder word of a child is refused, with no question to the parent and no model call", async (t) => {
  for (const role of ["builder", "explorer"] as const) {
    {
      const r = await rig(t, { role });
      const res = (await r.call("powershell", { command: pkgLine })) as { block?: boolean; reason?: string } | undefined;
      assert.equal(res?.block, true, role);
      assert.match(res?.reason ?? "", /denied for child sessions \(install-root-write\)/, role);
      assert.equal(fs.existsSync(path.join(r.askDir, "ask.md")), false, role);
      assert.equal(r.prompts.length, 0, role);
    }
  }
});
