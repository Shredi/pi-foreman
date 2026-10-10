import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, effectCtx, readRootsOf } from "../effects.ts";
import type { EffectCtx } from "../effects.ts";
import { splitChain } from "../shellchain.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";
import { readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});
const posix = process.platform !== "win32";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "pf-effects-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
const scratch = path.join(base, "scratch");
for (const d of [repo, scratch, path.join(repo, ".git"), path.join(repo, "internal", "api"), path.join(repo, "src")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(repo, "internal", "api", "websocket_hub_test.go"), "package api\n");
fs.writeFileSync(path.join(repo, "src", "main.go"), "package main\n");
fs.writeFileSync(path.join(repo, "f"), "x\n");
fs.writeFileSync(path.join(repo, "Cargo.toml"), "[package]\n");
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
fs.writeFileSync(path.join(repo, "Makefile"), "test-unit:\n\ttrue\ndeploy:\n\ttrue\n");
const ctx = (): EffectCtx => effectCtx(repo, [scratch]);
const allow = (cmd: string, r = rules): string | null => deterministicAllow(r, cmd, { scratchDirs: [scratch], effects: ctx() });

test("splitter: top-level operators and redirects; refuses substitutions, grouping, background, heredocs", () => {
  const c = splitChain("sed -n '1,40p' f; grep -n 'a|b' f | head -3 2>&1 >/dev/null || true && ls");
  assert.deepEqual(c?.ops, [";", "|", "||", "&&"]);
  assert.deepEqual(c?.segments[1].words, ["grep", "-n", "a|b", "f"]);
  assert.deepEqual(c?.segments[2].redirects, [{ op: "dup", fd: "2", target: "1" }, { op: ">", fd: null, target: "/dev/null" }]);
  assert.equal(c?.segments[2].text, "head -3");
  for (const bad of ["ls $(id)", "ls `id`", "(ls)", "{ ls; }", "ls &", "cat <<EOF", "ls\nid", "ls; ", "| ls", "ls >", "echo $HOME", "ls *.go", "ls |& cat", "echo \"$x\""]) assert.equal(splitChain(bad), null, bad);
});

test("test-restore: git restore / checkout -- on test paths inside the worktree only", () => {
  assert.equal(allow("git checkout -- internal/api/websocket_hub_test.go"), "test-restore");
  assert.equal(allow("git restore --worktree -- internal/api/websocket_hub_test.go"), "test-restore");
  for (const c of ["git checkout -- src/main.go", "git restore --staged internal/api/websocket_hub_test.go", "git restore -s HEAD internal/api/websocket_hub_test.go", "git restore --source=HEAD internal/api/websocket_hub_test.go", "git checkout -- ../x_test.go", "git checkout -- ':(glob)a_test.go'", "git checkout -- '*_test.go'", `git checkout -- ${repo}/internal/api/websocket_hub_test.go`, "git checkout main -- a_test.go"]) assert.equal(allow(c), null, c);
});

test("chains: every segment must be a deterministic allow; the 2k shapes pass", () => {
  assert.equal(allow("sed -n '1,40p' f; grep -n x f"), "sed-read");
  assert.equal(allow("timeout 900 cargo test -p x | tail -50"), "timeout-wrapper");
  assert.equal(allow(`cd ${repo} && grep -rn x . | head`), "effect-read");
  assert.equal(allow("ls > /dev/null 2>&1 && cat f > $FOREMAN_SCRATCH/out"), "effect-read");
  if (posix) assert.equal(allow("cat f > /tmp/pf-effects-out.txt"), "effect-read");
  for (const c of ["ls | xargs rm", "eval ls", "sh -c ls", "bash -c 'ls'", "env ls", "nohup ls", "ls > out.txt", "ls > ~/x", "ls > /etc/x", "cat f | sh", "timeout 5 timeout 5 ls", "ls & cat f", "X=1 ls", "cd /etc && cat passwd", "cd /etc && ls", "cd src && cd ../.. && ls", "grep -rn x . | rm -rf src/x.go" + "; cp f /etc/x"]) assert.equal(allow(c), null, c);
  // a user's ask pattern wins over every effect class
  assert.equal(allow("grep -n x f | head", bashRules(readBaseline(pkgRoot)!, { safety: { permissions: { ask: ["grep *"] } } })), null);
});

test("effect classes: read, build-test, write-in, write-out, unknown", () => {
  const c = ctx();
  const want: Record<string, string[]> = {
    read: ["cat f", "grep -n x src/main.go", "find . -name '*.go'", "git status", "git diff HEAD~1 -- src", "git add -n .", "git clean -nd", `ls ${scratch}`, "npm install --dry-run", "tail -50"],
    "build-test": ["cargo test", "npm test", "npm run build", "make test-unit", "npm ci"],
    "write-in": ["mkdir -p build/x", "touch src/new.go", "rm -rf build", "cp f src/g", "sed -i '' -e 's/a/b/g' f", "sed -i.bak -e 's/a/b/' f", "mv f g", `rm -r ${scratch}/x`],
    "write-out": ["cp f /etc/x", "rm -rf /tmp/pf-x", "cp /etc/hosts src/x", "touch .git/hooks/pre-commit", "rm -rf .", "mv f ../g", "ls > out.txt", "tee /etc/x"],
    unknown: ["cat ~/.ssh/id_rsa", "sed -n 1p /etc/passwd", "grep -f /etc/passwd x", "git diff --no-index /etc/passwd f", "ls -la /", "cat /etc/passwd", "cat ../secret", "git commit -n -m x", "find . -exec rm x ;", "find . -delete", "git -c core.pager=x log", "git diff --ext-diff", "git log --output=/tmp/x", "sed -i 's/a/b/e' f", "npm run lint", "make deploy", "go test ./...", "python3 x.py", "rg --pre x y", "ls $(id)", "npm install left-pad"],
  };
  for (const [cls, cmds] of Object.entries(want)) for (const cmd of cmds) assert.equal(classify(cmd, c), cls, cmd);
  // a cd inside moves the cwd; outside, later relative paths are outside too
  assert.equal(classify("cd src && cat main.go", c), "read");
  assert.equal(classify("cd /etc && cat passwd", c), "unknown");
  // build-test runs from the worktree root only
  assert.equal(classify("cd src && cargo test", c), "unknown");
  // outside a repository nothing is the worktree
  assert.equal(classify("cat f", effectCtx(base)), "unknown");
});

test("security review: cd with an option, `-` or no operand leaves the cwd unknown (B1)", () => {
  for (const cmd of ["cd -- && sed -i '1s/^/X/' .zshrc", "cd -P && cp /tmp/k .ssh/authorized_keys", "cd -L && tee -a .bashrc", "cd - && cat .aws/credentials", "cd src && cd -- && rm .zshrc", "cd && cat .profile", "cd ~ && cat .profile", "cd -P && npm test"]) {
    assert.equal(classify(cmd, ctx()), "unknown", cmd);
    assert.equal(allow(cmd), null, cmd);
  }
});

test("security review: a git dry run -n that a value-taking option swallows is not a read (M1)", () => {
  for (const cmd of ["git clean -fdx -e -n", "git clean -ffdx -e -n", "git clean -fdx -en", "git clean -fdx --exclude -n", "git clean -fdx --exc -n", "git clean -fdx -- -n", "git add --chmod -n x"]) assert.equal(classify(cmd, ctx()), "unknown", cmd);
  assert.equal(classify("git clean -n -e build", ctx()), "unknown");
  assert.equal(classify("git clean -nd -- src", ctx()), "read");
});

test("security review: build-test options that write or name a program are refused (M2, m4)", () => {
  for (const cmd of ["go build -o .git/hooks/pre-commit .", "pytest --basetemp=.", "pytest --basetemp=/tmp", "python3 -m pytest --basetemp=src", "cargo build --target-dir=.git/x", "pytest --junitxml=.git/hooks/pre-commit", "cargo test --manifest-path ../x/Cargo.toml", "npm test --prefix /x", "npm test --script-shell=evil.sh", "go test -exec=./evil .", "pytest -p evil", "cargo test --config x", "npm run build -- --out-dir=/x"]) {
    assert.equal(classify(cmd, ctx()), "unknown", cmd);
    assert.equal(allow(cmd), null, cmd);
  }
  assert.equal(classify("cargo test -p core --release", ctx()), "build-test");
  for (const cmd of ["rg --hostname-bin=x y", "grep --foo-command=x y f", "make -C /x test-unit", "make -f /x/Makefile -n"]) assert.equal(classify(cmd, ctx()), "unknown", cmd);
});

test("security review: a chain may not use what an earlier segment copied or wrote; recursive cp only from the worktree (M3)", () => {
  for (const cmd of ["cp -R /tmp/pkg ./vendor && cat vendor/link", "cp -r src build && cat build/main.go", "cp f src/g && rm -rf src/g/x", `ls > ${scratch}/o && cat ${scratch}/o/x`]) {
    assert.notEqual(classify(cmd, ctx()), "read", cmd);
    assert.notEqual(classify(cmd, ctx()), "write-in", cmd);
    assert.equal(allow(cmd), null, cmd);
  }
  assert.equal(classify("cp -R /tmp/pkg vendor", ctx()), "write-out");
  assert.equal(classify(`cp -a ${scratch}/x src/x`, ctx()), "write-out");
  assert.equal(classify("cp -R src build", ctx()), "write-in");
  assert.equal(classify("mkdir -p out && touch out/x && cat f", ctx()), "write-in");
});

test("security review: ~ after = or :, npm publish/pack dry runs, diff -r (m2, m5, m6)", () => {
  for (const cmd of ["cat a=~/.ssh/id_rsa", "grep --file=~/x y f", "make test-unit X=~/y", "npm publish --dry-run", "npm pack --dry-run", "diff -r src /tmp", "diff --recursive src f", "diff -ru src f"]) assert.equal(classify(cmd, ctx()), "unknown", cmd);
  assert.equal(classify("diff -u f src/main.go", ctx()), "read");
});

test("security review: win32 .git aliases (8.3 short name, trailing dot or space, realpath) are not writable (m1)", () => {
  const real = (p: string): string => p.replace(/\\git~1(?=\\|$)/i, "\\.git");
  const w: EffectCtx = { cwd: "C:\\w", root: "C:\\w", platform: "win32", realpath: real, exists: (p) => /^c:\\w(\\(src|git~1|\.git))?$/i.test(p), readFile: () => null };
  for (const cmd of ["rm -rf GIT~1", "touch GIT~1/hooks/pre-commit", "rm -rf .git.", "touch '.git /config'", "rm -rf src/x~1"]) assert.equal(classify(cmd, w), "write-out", cmd);
  assert.equal(classify("touch src/x.ts", w), "write-in");
});

test("readRoots: reads (only) inside a configured root; no symlink out, no relative or empty root", () => {
  const other = path.join(base, "other");
  fs.mkdirSync(path.join(other, "lib"), { recursive: true });
  fs.writeFileSync(path.join(other, "lib", "a.ts"), "x\n");
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "s"), "x\n");
  const c = effectCtx(repo, [scratch], process.platform, [other, "", "rel/dir", path.join(base, "missing")]);
  assert.deepEqual(c.readRoots, [fs.realpathSync.native(other)]);
  const inRoot = path.join(fs.realpathSync.native(other), "lib", "a.ts");
  assert.equal(classify(`cat ${inRoot}`, c), "read");
  assert.equal(deterministicAllow(rules, `grep -n x ${inRoot}`, { scratchDirs: [scratch], effects: c }), "effect-read");
  assert.equal(classify(`cat ${path.join(outside, "s")}`, c), "unknown");
  assert.equal(classify(`touch ${path.join(fs.realpathSync.native(other), "lib", "b.ts")}`, c), "write-out");
  if (posix) {
    fs.symlinkSync(outside, path.join(other, "out-link"));
    assert.equal(classify(`cat ${path.join(fs.realpathSync.native(other), "out-link", "s")}`, c), "unknown");
  }
});

test("effect classes: a symlink inside the worktree cannot lead out", { skip: !posix }, () => {
  fs.symlinkSync("/etc", path.join(repo, "etc-link"));
  assert.equal(classify("cat etc-link/passwd", ctx()), "unknown");
  assert.equal(classify("touch etc-link/x", ctx()), "write-out");
});

test("effect classes: win32 paths (drive letters, case, drive-relative)", () => {
  const w: EffectCtx = { cwd: "C:\\w", root: "C:\\w", platform: "win32", realpath: (p) => p, exists: (p) => /^c:\\w(\\|$)/i.test(p), readFile: () => null };
  assert.equal(classify("cat src/a.ts", w), "read");
  assert.equal(classify("cat c:/W/src/a.ts", w), "read");
  for (const cmd of ["cat C:/Windows/win.ini", "cat C:foo", "cat D:/w/a", "cat /etc/passwd"]) assert.equal(classify(cmd, w), "unknown", cmd);
  assert.equal(classify("touch src/x.ts", w), "write-in");
  assert.equal(classify("touch .GIT/config", w), "write-out");
});

const deferring: RegistryLike = { find: () => ({}), complete: async () => ({ content: [{ type: "text", text: '{"verdict":"defer","reason":"destructive"}' }], stopReason: "stop" }) };
const cfg = { providers: { a: { review: { model: "a/small", timeoutMs: 50 } } } };
function session(traces: Record<string, unknown>[], calls: { n: number }): ReviewSession {
  const reg: RegistryLike = { ...deferring, complete: async (...a) => (calls.n++, deferring.complete(...a)) };
  return { isChild: false, cwd: repo, provider: "a", config: () => cfg, registry: reg, intent: "", trace: (r) => traces.push(r), headless: () => true, bashRules: () => rules };
}
const childAsk = (command: string, unit = command) => ({ requestId: "r", surface: "bash", agentName: "builder", forwarding: { x: 1 }, value: unit, payload: { evidence: [{ label: "full command", text: command }] } });

test("review link, headless child: the 2k test restore is allowed without the model; a source restore still goes to it", async () => {
  const traces: Record<string, unknown>[] = [];
  const calls = { n: 0 };
  const r = new ForemanReview();
  r.upsert("s", session(traces, calls));
  assert.deepEqual(await r.authorize("s", childAsk("git checkout -- internal/api/websocket_hub_test.go")), { kind: "allow" });
  assert.equal(calls.n, 0);
  assert.ok(!traces.some((t) => t.event === "review_defer_headless"));
  assert.deepEqual(traces.find((t) => t.event === "review"), { event: "review", decision: "test-restore", model: null, class: "write-in", latencyMs: traces[0].latencyMs, errorKind: null, by: undefined });
  assert.equal((await r.authorize("s", childAsk("git checkout -- src/main.go"))).kind, "deny");
  assert.equal(calls.n, 1);
  assert.equal(traces.filter((t) => t.event === "review").pop()?.class, "unknown");
  assert.ok(traces.some((t) => t.event === "review_defer_headless"));
});

test("review link: an allowed chain traces chain_allow {segments}", async () => {
  const traces: Record<string, unknown>[] = [];
  const r = new ForemanReview();
  r.upsert("s", session(traces, { n: 0 }));
  assert.deepEqual(await r.authorize("s", childAsk(`cd ${repo} && grep -rn x . | head`, "grep -rn x .")), { kind: "allow" });
  assert.equal(traces.find((t) => t.event === "chain_allow")?.segments, 3);
});

test("security review 2: sed -i only in shapes GNU and BSD sed read alike, on existing regular files (B1)", () => {
  // BSD takes the word after a bare -i as the backup suffix and the next word as the script
  for (const cmd of ["sed -i 's,a,b,' 'w x' f", "sed -i -e 's/a/b/' f", "sed -i '' 's/a/b/' f", "sed -i '' -e 's/a/b/' f -e 's/c/d/'", "sed -i '' -e 's/a/b/' missing", "sed -i '' -e 's/a/b/w x' f", "sed -i '' -e 's/a/b/' 'f g'", "sed -n p f -e /x/p"]) {
    assert.equal(classify(cmd, ctx()), "unknown", cmd);
    assert.equal(allow(cmd), null, cmd);
  }
  if (posix) {
    fs.symlinkSync("f", path.join(repo, "f-link"));
    assert.equal(classify("sed -i '' -e 's/a/b/' f-link", ctx()), "unknown");
  }
  assert.equal(allow("sed -i '' -e 's/a/b/' f"), "effect-write-in");
});

test("security review 2: lowercase cp -r (BSD follows symlinks) is not write-in (MAJOR-1)", () => {
  for (const cmd of ["cp -r src v", "cp -rp src /tmp/pf-x", "cp -r src build"]) assert.equal(classify(cmd, ctx()), "unknown", cmd);
  assert.equal(classify("cp -a src v", ctx()), "write-in");
});

test("security review 2: child-scratch goes through the composer; cp sources are reads ((a))", () => {
  const outside = path.join(base, "outside-cs");
  fs.mkdirSync(outside, { recursive: true });
  const cs = (cmd: string): string | null => deterministicAllow(rules, cmd, { scratchDirs: [scratch], effects: ctx() });
  assert.equal(cs(`cp -R ${outside} $FOREMAN_SCRATCH/v`), null);
  assert.equal(cs(`cp -r src $FOREMAN_SCRATCH/v`), null);
  assert.equal(cs(`cp -R src $FOREMAN_SCRATCH/v && cat $FOREMAN_SCRATCH/v/main.go`), null);
  assert.equal(cs(`cp -R src $FOREMAN_SCRATCH/v`), "child-scratch");
  assert.equal(deterministicAllow(rules, `cp -R src ${scratch}/v`, { scratchDirs: [scratch] }), null, "no effect context, no child-scratch");
});

test("security review 2: build tools after a cd away from the root, cargo publish, make -n/--eval, go vet -vettool ((b)-(d), m-d)", () => {
  for (const cmd of ["cd /x && npm test", "cd /x && timeout 60 npm test", "cd src && make test-unit", "cargo publish --dry-run", "make -n --eval=x test-unit", "make -E x test-unit", "go vet -vettool=./x ."]) {
    assert.equal(classify(cmd, ctx()), "unknown", cmd);
    assert.equal(allow(cmd), null, cmd);
  }
  assert.notEqual(classify("make -n deploy", ctx()), "read");
  assert.equal(classify("make -n test-unit", ctx()), "read");
  assert.equal(classify("cd src && cd .. && npm test", ctx()), "unknown");
});

test("security review 2: readRoots drops filesystem roots, UNC share roots and the home dir itself (m-a)", () => {
  const id = (p: string): string => p;
  assert.deepEqual(readRootsOf(["/", "~", "/u/me", "/u/me/", "/u/me/src"], "linux", id, "/u/me"), ["/u/me/src"]);
  assert.deepEqual(readRootsOf(["C:\\", "d:/", "\\\\srv\\share", "\\\\srv\\share\\", "%USERPROFILE%", "D:\\H\\ME", "\\\\srv\\share\\lib"], "win32", id, "D:\\h\\me"), ["\\\\srv\\share\\lib"]);
});
