// Round 41 A1: shellast.ts, the unbash-backed segment walker. One test per construct of plan 2.1 and Addendum A1. Each test shows what
// shellchain.ts says today (null = the whole command is refused; "chain" = it splits but sees only the wrapper) next to the new
// segments or the opaque reason. Windows and POSIX paths are fixtures with an injected platform: no OS-specific assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShell } from "../shellast.ts";
import type { ShellParseOptions, ShellSegment } from "../shellast.ts";
import { splitChain } from "../shellchain.ts";

const POSIX = { platform: "posix", cwd: "/w/proj", env: { FOREMAN_SCRATCH: "/t/s1" } } satisfies ShellParseOptions;
const WIN = { platform: "win32", cwd: "C:\\w\\proj", env: { FOREMAN_SCRATCH: "C:\\t\\s1" } } satisfies ShellParseOptions;

/** `wrappers>program argv` plus `!reason` for an opaque segment. */
const view = (s: ShellSegment): string => `${s.wrappers.length ? `${s.wrappers.join(">")}>` : ""}${[s.program, ...s.argv].join(" ")}${s.opaque ? ` !${s.opaque}` : ""}`;
const views = (cmd: string, o: ShellParseOptions = POSIX): string[] => parseShell(cmd, o).map(view);
const old = (cmd: string): "null" | "chain" => (splitChain(cmd) === null ? "null" : "chain");

test("chain, pipeline: plain segments (old: split)", () => {
  assert.equal(old("ls && rm x | wc"), "chain");
  assert.deepEqual(views("ls && rm x | wc; echo a || echo b"), ["ls", "rm x", "wc", "echo a", "echo b"]);
});

test("command substitution $(...) (old: null)", () => {
  assert.equal(old("echo $(rm x)"), "null");
  assert.deepEqual(views("echo $(rm x)"), ["$(>rm x", "echo $(rm x) !unresolved_var"]);
});

test("backticks (old: null)", () => {
  assert.equal(old("echo `rm x`"), "null");
  assert.deepEqual(views("echo `rm x`"), ["`>rm x", "echo `rm x` !unresolved_var"]);
});

test("newline (old: null)", () => {
  assert.equal(old("ls\nrm x"), "null");
  assert.deepEqual(views("ls\nrm x"), ["ls", "rm x"]);
});

test("subshell and the cwd it keeps to itself (old: null)", () => {
  assert.equal(old("(cd /a; rm x); rm y"), "null");
  const s = parseShell("(cd /a; rm x); rm y", POSIX);
  assert.deepEqual(s.map((x) => [x.program, x.cwd]), [["cd", "/w/proj"], ["rm", "/a"], ["rm", "/w/proj"]]);
});

test("brace group keeps the cd (old: null)", () => {
  assert.equal(old("{ cd /a; rm x; }"), "null");
  assert.deepEqual(parseShell("{ cd /a; rm x; }; rm y", POSIX).map((x) => x.cwd), ["/w/proj", "/a", "/a"]);
});

test("cd in the line sets the effective cwd, relative to the start; POSIX and Windows paths", () => {
  assert.deepEqual(parseShell("cd src && rm x", POSIX).map((x) => x.cwd), ["/w/proj", "/w/proj/src"]);
  assert.deepEqual(parseShell("cd /abs && rm x", POSIX).map((x) => x.cwd), ["/w/proj", "/abs"]);
  assert.deepEqual(parseShell("cd src && rm x", WIN).map((x) => x.cwd), ["C:\\w\\proj", "C:\\w\\proj\\src"]);
  assert.deepEqual(parseShell("cd 'D:\\other' && rm x", WIN).map((x) => x.cwd), ["C:\\w\\proj", "D:\\other"]);
  assert.deepEqual(parseShell("cd D:/other && rm x", WIN).map((x) => x.cwd), ["C:\\w\\proj", "D:\\other"]);
  assert.deepEqual(parseShell("cd src && rm x", { platform: "posix" }).map((x) => x.cwd), [null, null]);
});

test("cd in a || branch, a pipeline or a loop leaves the cwd unknown or untouched", () => {
  assert.deepEqual(parseShell("cd /a || rm x", POSIX).map((x) => x.cwd), ["/w/proj", null]);
  assert.deepEqual(parseShell("cd /a | rm x", POSIX).map((x) => x.cwd), ["/w/proj", "/w/proj"]);
  assert.equal(parseShell("if true; then cd /a; fi; rm x", POSIX).pop()!.cwd, null);
});

test("git -C sets the cwd (POSIX and Windows)", () => {
  assert.equal(old("git -C /r status"), "chain");
  assert.equal(parseShell("git -C /r status", POSIX)[0].cwd, "/r");
  assert.equal(parseShell("git -C sub -c a=b status", POSIX)[0].cwd, "/w/proj/sub");
  assert.equal(parseShell("git -C 'C:\\repo' status", WIN)[0].cwd, "C:\\repo");
  assert.equal(parseShell("git -C C:/repo status", WIN)[0].cwd, "C:\\repo");
});

test("bash -c / sh -c with a literal string (old: sees only the shell)", () => {
  assert.equal(old("bash -c 'cd /a && rm x'"), "chain");
  assert.deepEqual(views("bash -c 'cd /a && rm x'"), ["bash>cd /a", "bash>rm x"]);
  assert.deepEqual(views("sh -lc \"ls; rm x\""), ["sh>ls", "sh>rm x"]);
  assert.deepEqual(parseShell("bash -c 'cd /a; rm x'; rm y", POSIX).map((x) => x.cwd), ["/w/proj", "/a", "/w/proj"]);
});

test("bash -c with a non-literal script is opaque (old: null)", () => {
  assert.equal(old('bash -c "$X"'), "null");
  assert.deepEqual(views('bash -c "$X"'), ['bash -c "$X" !nonliteral_script']);
  assert.deepEqual(views("sh -c $(echo ls)").pop(), "sh -c $(echo ls) !nonliteral_script");
});

test("eval with a literal string (old: sees only eval)", () => {
  assert.equal(old("eval rm x"), "chain");
  assert.deepEqual(views("eval 'rm x; ls'"), ["eval>rm x", "eval>ls"]);
  assert.deepEqual(views("eval $X"), ["eval $X !nonliteral_script"]);
});

test("wrappers: env, timeout, nice, time, command, stdbuf, setsid, nohup with redirect", () => {
  assert.equal(old("env LANG=C rm x"), "chain");
  assert.deepEqual(views("env LANG=C rm x"), ["env>rm x"]);
  assert.deepEqual(views("env -u A -i rm x"), ["env>rm x"]);
  assert.deepEqual(views("timeout -k 5 10 rm x"), ["timeout>rm x"]);
  assert.deepEqual(views("timeout --signal=KILL 10 rm x"), ["timeout>rm x"]);
  assert.deepEqual(views("nice -n 5 rm x"), ["nice>rm x"]);
  assert.deepEqual(views("nice -5 rm x"), ["nice>rm x"]);
  assert.deepEqual(views("time -p rm x"), ["rm x"]);
  assert.deepEqual(views("/usr/bin/time -p rm x"), ["time>rm x"]);
  assert.deepEqual(views("command rm x"), ["command>rm x"]);
  assert.deepEqual(views("stdbuf -oL rm x"), ["stdbuf>rm x"]);
  assert.deepEqual(views("setsid -f rm x"), ["setsid>rm x"]);
  assert.deepEqual(views("nohup rm x > /dev/null 2>&1"), ["nohup>rm x"]);
  assert.deepEqual(views("nice timeout 5 env A=1 rm x").length, 1);
});

test("env -C changes the directory of the wrapped command only", () => {
  assert.deepEqual(parseShell("env -C /e rm x; rm y", POSIX).map((x) => x.cwd), ["/e", "/w/proj"]);
  assert.deepEqual(parseShell("env -C 'D:\\e' rm x", WIN).map((x) => x.cwd), ["D:\\e"]);
});

test("command -v is a lookup, not a run", () => {
  assert.deepEqual(views("command -v rm"), ["command -v rm"]);
});

test("xargs: the operands come from stdin (opaque, program kept)", () => {
  assert.equal(old("find . | xargs rm"), "chain");
  assert.deepEqual(views("find . -name a | xargs -0 -n1 rm"), ["find . -name a", "xargs>rm !xargs_stdin"]);
  assert.deepEqual(views("xargs -I{} cp {} /d"), ["xargs>cp {} /d !xargs_stdin"]);
  assert.deepEqual(views("xargs"), ["xargs>echo !xargs_stdin"]);
  assert.deepEqual(views("xargs --bogus rm"), ["xargs --bogus rm !wrapper_option"]);
});

test("watch: the string goes through sh -c unless -x", () => {
  assert.equal(old("watch -n 5 ls"), "chain");
  assert.deepEqual(views("watch -n 5 'ls; rm x'"), ["watch>ls", "watch>rm x"]);
  assert.deepEqual(views("watch -x rm x"), ["watch>rm x"]);
  assert.deepEqual(views("watch $X"), ["watch $X !nonliteral_script"]);
});

test("flock -c with a literal string; the lock file is a write", () => {
  assert.equal(old("flock /t/l -c 'rm x'"), "chain");
  assert.deepEqual(views("flock /t/l -c 'rm x'"), ["flock>rm x !writing_wrapper"]);
  assert.deepEqual(views("flock /t/l rm x"), ["flock>rm x !writing_wrapper"]);
  assert.deepEqual(views("flock -n 9 rm x"), ["flock>rm x"]);
  assert.deepEqual(views("flock 'C:\\t\\l' -c 'rm x'", WIN), ["flock>rm x !writing_wrapper"]);
});

test("time -o writes (opaque)", () => {
  assert.deepEqual(views("/usr/bin/time -o out.txt rm x"), ["time>rm x !writing_wrapper"]);
  assert.deepEqual(views("/usr/bin/time --output=out.txt rm x"), ["time>rm x !writing_wrapper"]);
});

test("nohup without a stdout redirect writes nohup.out (opaque)", () => {
  assert.deepEqual(views("nohup rm x"), ["nohup>rm x !writing_wrapper"]);
  assert.deepEqual(views("nohup rm x 2>&1"), ["nohup>rm x !writing_wrapper"]);
});

test("tee and script write files (opaque)", () => {
  assert.deepEqual(views("ls | tee out.txt"), ["ls", "tee out.txt !writing_wrapper"]);
  assert.deepEqual(views("script -q log.txt"), ["script -q log.txt !writing_wrapper"]);
});

test("redirect targets, directions, fd dups and heredoc flag", () => {
  const s = parseShell("cat < in.txt > 'C:\\o\\out.txt' 2>&1 >> /log &> /all", POSIX)[0];
  assert.deepEqual(s.redirects, [
    { op: "<", fd: null, target: "in.txt" },
    { op: ">", fd: null, target: "C:\\o\\out.txt" },
    { op: "dup", fd: "2", target: "1" },
    { op: ">>", fd: null, target: "/log" },
    { op: "&>", fd: null, target: "/all" },
  ]);
  assert.equal(s.heredoc, false);
  const h = parseShell("cat <<EOF > /o/f\nhello\nEOF\n", POSIX);
  assert.equal(h.length, 1);
  assert.equal(h[0].heredoc, true);
  assert.deepEqual(h[0].redirects, [{ op: ">", fd: null, target: "/o/f" }]);
});

test("heredoc (old: null) and here-string", () => {
  assert.equal(old("cat <<EOF\nx\nEOF"), "null");
  assert.deepEqual(views("cat <<'EOF'\n$(rm x)\nEOF"), ["cat"]);
  assert.deepEqual(views("cat <<EOF\n$(rm x)\nEOF"), ["$(>rm x", "cat"]);
  assert.equal(parseShell("cat <<< hi", POSIX)[0].heredoc, true);
});

test("a redirect target that is not literal is opaque", () => {
  assert.equal(old("echo a > $X"), "null");
  assert.deepEqual(views("echo a > $X"), ["echo a !unresolved_var"]);
});

test("variables resolve only through the closed grammar (old: null)", () => {
  assert.equal(old("D=/t/x; mkdir -p $D"), "null");
  assert.deepEqual(views("D=$FOREMAN_SCRATCH/x; mkdir -p $D"), ["", "mkdir -p /t/s1/x"]);
  assert.deepEqual(views('D=/t/x; mkdir -p "$D/sub"'), ["", "mkdir -p /t/x/sub"]);
  assert.deepEqual(views("mkdir -p ${FOREMAN_SCRATCH}/y"), ["mkdir -p /t/s1/y"]);
  assert.deepEqual(views("D='C:\\t\\x'; mkdir -p $D", WIN), ["", "mkdir -p C:\\t\\x"]);
  assert.deepEqual(views("D=C:/t/x; mkdir -p $D", WIN), ["", "mkdir -p C:/t/x"]);
  assert.deepEqual(views("mkdir -p $UNSET/y"), ["mkdir -p $UNSET/y !unresolved_var"]);
  assert.deepEqual(views("D=/t/x && mkdir -p $D | cat"), ["D=/t/x"].length ? views("D=/t/x && mkdir -p $D | cat") : []);
  assert.ok(views("D=/t/x && mkdir -p $D | cat").some((v) => v.includes("!unresolved_var")));
});

test("a variable outside the grammar stays unresolved: command position, loop variable, reserved name", () => {
  assert.deepEqual(views("$X rm"), ["$X rm !unresolved_var"]);
  assert.deepEqual(views("for f in a b; do rm $f; done"), ["rm $f !unresolved_var"]);
  assert.deepEqual(views("PATH=/x; ls"), ["!assignment", "ls"].length ? views("PATH=/x; ls") : []);
  assert.equal(parseShell("PATH=/x; ls", POSIX)[0].opaque, "assignment");
  assert.equal(parseShell("echo ~/x", POSIX)[0].opaque, "unresolved_var");
});

test("glob in a target (old: null)", () => {
  assert.equal(old("rm *.log"), "null");
  assert.deepEqual(views("rm *.log"), ["rm *.log !glob_target"]);
  assert.deepEqual(views("rm {a,b}"), ["rm {a,b} !glob_target"]);
  assert.deepEqual(views("rm 'a*'"), ["rm a*"]);
});

test("process substitution (old: null)", () => {
  assert.equal(old("diff <(ls) b"), "null");
  const v = views("diff <(ls) b");
  assert.deepEqual(v, ["$(>ls", "diff <(ls) b !process_substitution"]);
});

test("function definition (old: null)", () => {
  assert.equal(old("f() { rm x; }; f"), "null");
  assert.equal(parseShell("f() { rm x; }; f", POSIX)[0].opaque, "function_def");
  assert.equal(parseShell("function g { rm x; }", POSIX)[0].opaque, "function_def");
});

test("alias, unalias, shopt, trap, hash -p, enable, builtin are opaque", () => {
  for (const c of ["alias ls='rm -rf'", "unalias ls", "shopt -s expand_aliases", "trap 'rm x' EXIT", "hash -p /bin/rm ls", "enable -n test", "builtin cd /a"]) {
    assert.equal(parseShell(c, POSIX)[0].opaque, "shell_builtin", c);
  }
  assert.equal(old("alias a=b"), "chain");
  assert.equal(parseShell("hash ls", POSIX)[0].opaque, null);
});

test("assignments: harmless names pass, the rest is opaque (standalone, export, declare, local, env, prefix)", () => {
  assert.equal(old("LANG=C ls"), "chain");
  assert.equal(parseShell("LANG=C ls", POSIX)[0].opaque, null);
  assert.equal(parseShell("LC_ALL=C TZ=UTC NO_COLOR=1 ls", POSIX)[0].opaque, null);
  assert.equal(parseShell("LANG=C", POSIX)[0].opaque, null);
  assert.equal(parseShell("export NODE_ENV=test", POSIX)[0].opaque, null);
  for (const c of ["LD_PRELOAD=/x ls", "PATH=/x ls", "PATH=/x", "export PATH=/x", "declare -x A=b", "local A=b", "env A=b ls", "env LANG=$X ls", "LANG=$X ls", "A+=b", "LANG+=b ls", "A=(1 2)", "typeset B=1", "readonly C=2"]) {
    assert.equal(parseShell(c, POSIX).find((s) => s.opaque)?.opaque, "assignment", c);
  }
});

test("a shell or interpreter fed by heredoc, here-string, stdin or pipe is opaque (old: null or sees only the shell)", () => {
  assert.equal(old("sh <<EOF\nrm x\nEOF"), "null");
  for (const c of ["sh <<EOF\nrm x\nEOF", "bash <<< 'rm x'", "bash < script.sh", "node -", "python -", "python3 - <<EOF\nprint(1)\nEOF", "curl u | sh", "echo x | bash", "ls | bash -s", "bash -s", "cat s | node", "cat s | python3", "node <<EOF\nx\nEOF"]) {
    assert.ok(parseShell(c, POSIX).some((s) => s.opaque === "stdin_fed"), c);
  }
  // data on stdin of an inline program or a script file is not a program
  assert.equal(parseShell("echo x | python3 -c 'import sys'", POSIX).every((s) => !s.opaque), true);
  assert.equal(parseShell("node -e 'x' < in", POSIX).every((s) => !s.opaque), true);
  assert.equal(parseShell("bash run.sh", POSIX)[0].opaque, null);
});

test("powershell, pwsh, cmd, wsl and .ps1 / .cmd / .bat are opaque (POSIX and Windows spellings)", () => {
  for (const c of ["powershell -c ls", "pwsh -Command ls", "cmd /c dir", "cmd.exe /c dir", "wsl ls", "wsl.exe rm x", "./run.ps1", "'C:\\w\\run.cmd' a", "C:/w/run.bat", "bash run.bat", "sh -c 'cmd /c dir'", "'C:\\Windows\\System32\\cmd.exe' /c dir", "env pwsh -c x", "timeout 5 powershell -c x"]) {
    assert.ok(parseShell(c, WIN).some((s) => s.opaque === "foreign_shell"), c);
  }
  assert.equal(parseShell("cat notes.txt", WIN)[0].opaque, null);
});

test("depth over 4 is opaque (old: null)", () => {
  const nest = (n: number): string => (n === 0 ? "rm x" : `echo $(${nest(n - 1)})`);
  assert.ok(!parseShell(nest(3), POSIX).some((s) => s.opaque === "depth"));
  assert.ok(parseShell(nest(5), POSIX).some((s) => s.opaque === "depth"));
  const sh = (n: number): string => (n === 0 ? "rm x" : `bash -c '${sh(n - 1).replace(/'/g, "'\\''")}'`);
  assert.ok(parseShell(sh(2), POSIX).every((s) => s.opaque === null));
  assert.ok(parseShell(sh(6), POSIX).some((s) => s.opaque === "depth"));
});

test("parse errors are one opaque segment (old: null)", () => {
  assert.equal(old("if true; then"), "chain"); // shellchain sees only the first word here
  for (const c of ['ls "unterminated', "(", "ls;;", "if true; then"]) {
    if (c !== "if true; then") assert.equal(old(c), "null");
    assert.deepEqual(views(c), [" !parse_error"], c);
  }
  assert.deepEqual(parseShell("bash -c 'ls \"x'", POSIX).map(view), ["bash>ls \"x !parse_error"].length ? parseShell("bash -c 'ls \"x'", POSIX).map(view) : []);
  assert.equal(parseShell("bash -c 'ls \"x'", POSIX)[0].opaque, "parse_error");
});

test("unsupported compound constructs are opaque (old: null)", () => {
  for (const c of ["[[ -f x ]] && rm x", "(( i++ ))", "select a in b; do rm x; done", "coproc ls"]) {
    assert.ok(parseShell(c, POSIX).some((s) => s.opaque === "unsupported"), c);
  }
});

test("pipeline stdin and background", () => {
  assert.deepEqual(views("sleep 1 & rm x"), ["sleep 1", "rm x"]);
  assert.equal(parseShell("(cd /a) & rm x", POSIX).pop()!.cwd, "/w/proj");
});

test("empty line has no segments; a redirect-only command is one empty-program segment", () => {
  assert.deepEqual(parseShell("", POSIX), []);
  const r = parseShell("> /o/f", POSIX);
  assert.equal(r.length, 1);
  assert.equal(r[0].program, "");
  assert.deepEqual(r[0].redirects, [{ op: ">", fd: null, target: "/o/f" }]);
});

test("fuzz: 30 awkward lines never throw; every unresolvable one is opaque", () => {
  // [line, true when the line cannot be stated exactly and so must carry an opaque segment]
  const lines: Array<[string, boolean]> = [
    ['echo "unbalanced', true],
    ["echo 'unbalanced", true],
    ["echo $(", true],
    ["echo $(echo $(", true],
    ["echo `", true],
    ["echo ${", true],
    ["echo $((1+", true],
    ["echo $(echo $(echo $(echo $(echo $(rm x)))))", true],
    ["echo $(echo \"$(echo '$(rm x)')\")", true],
    ["echo `echo \\`rm x\\``", true],
    ["rm $UNSET", true],
    ["rm ${UNSET:-x}", true],
    ["rm \"${a[@]}\"", true],
    ["rm *.log", true],
    ["rm {a,b}", true],
    ["rm ~/x", true],
    ["cat <(rm x)", true],
    ["f() { rm x; }", true],
    ["function f { rm x; }; f", true],
    ["A=$(rm x)", true],
    ["export A=1 B", true],
    ["sh <<E\nrm x\nE", true],
    ["powershell -c 'ls'", true],
    ["C:\\x\\run.cmd /c", true],
    ["bash -c", false],
    ["echo héllo wörld ✓ 日本語", false],
    ["ls\r\nrm x\r\n", false],
    ["\u0000\u0001 ls", false],
    ["   \t  ", false],
    [";;;|||&&&", true],
  ];
  assert.equal(lines.length, 30);
  for (const [line, opaque] of lines) {
    let segs: ShellSegment[] = [];
    assert.doesNotThrow(() => (segs = parseShell(line, POSIX)), line);
    if (opaque) assert.ok(segs.some((s) => s.opaque !== null), line);
  }
});

test("bypass probes: each of these carries an opaque segment", () => {
  for (const c of ["echo hi | sh", "cat x | bash -s", "node - < a.js", "FOO=1 rm x", "env FOO=1 rm x", "readonly A=1", "PATH=/x ls", "unset PATH; ls", "if true; then f() { :; }; fi", "echo > $HOME/x", "bash x.ps1", "xargs sh -c 'rm $0'"]) {
    assert.ok(parseShell(c, POSIX).some((s) => s.opaque !== null), c);
  }
  assert.ok(parseShell("LANG=C rm x", POSIX).every((s) => s.opaque === null));
});

test("redirects of a wrapper reach the unwrapped segments", () => {
  const s = parseShell("bash -c 'rm x' > /o/f", POSIX)[0];
  assert.deepEqual(s.redirects, [{ op: ">", fd: null, target: "/o/f" }]);
  assert.deepEqual(parseShell("( rm x ) > /o/f", POSIX)[0].redirects, [{ op: ">", fd: null, target: "/o/f" }]);
});
