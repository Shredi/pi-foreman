// Git drift asks only for changes that can run a program or redirect git (hooks, exec-capable config keys); other keys update the baseline silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { GitDriftWatch, diffGitSnapshots, parseGitConfig, parseGitConfigLines, takeGitSnapshot } from "../gitdrift.ts";

const HOME = os.tmpdir();

function tempRepo(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-drift-exec-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://example.invalid/r.git\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  return dir;
}

const config = (dir: string) => path.join(dir, ".git", "config");
const drift = (dir: string, before: ReturnType<typeof takeGitSnapshot>) => diffGitSnapshots(before, takeGitSnapshot(dir, HOME));

test("branch.main.vscode-merge-base added: no ask", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[branch \"main\"]\n\tvscode-merge-base = origin/main\n");
  assert.deepEqual(drift(dir, before), []);
});

test("unknown non-exec keys added, changed and removed: no ask", (t) => {
  const dir = tempRepo(t);
  fs.appendFileSync(config(dir), "[foo]\n\tbar = 1\n[user]\n\tname = a\n");
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[branch \"x\"]\n\tdescription = hi\n");
  assert.deepEqual(drift(dir, before), []);
  fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace("bar = 1", "bar = 2").replace("name = a", "name = b"));
  assert.deepEqual(drift(dir, before), []);
  fs.writeFileSync(config(dir), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://example.invalid/r.git\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n");
  assert.deepEqual(drift(dir, before), []);
});

test("a non-exec key beside an exec key names only the exec key", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[branch \"main\"]\n\tvscode-merge-base = o\n[core]\n\tfsmonitor = /tmp/SECRET\n");
  assert.deepEqual(drift(dir, before), ["git:config: added core.fsmonitor"]);
});

const EXEC: Array<[string, string]> = [
  ["core", "fsmonitor = x"], ["core", "hooksPath = x"], ["core", "sshCommand = x"], ["core", "pager = x"], ["core", "editor = x"], ["core", "askPass = x"],
  ["core", "gitProxy = x"], ["core", "worktree = x"], ["core", "attributesFile = x"],
  ['url "https://a/"', "insteadOf = x"], ['url "https://a/"', "pushInsteadOf = x"],
  ['filter "lfs"', "clean = x"], ['filter "lfs"', "smudge = x"],
  ['diff "d"', "textconv = x"], ['diff "d"', "command = x"], ["diff", "external = x"],
  ['merge "m"', "driver = x"],
  ['remote "origin"', "pushurl = x"], ['remote "origin"', "uploadpack = x"], ['remote "origin"', "receivepack = x"], ['remote "origin"', "proxy = x"], ['remote "o2"', "url = x"],
  ["alias", "st = !x"], ['credential "https://a"', "helper = x"], ["credential", "helper = x"],
  ["gpg", "program = x"], ['gpg "ssh"', "program = x"], ["sequence", "editor = x"],
  ["include", "path = x"], ['includeIf "gitdir:/x/"', "path = x"],
  ['protocol "ext"', "allow = always"], ["protocol", "allow = always"],
  ["http", "proxy = x"], ['http "https://a/"', "proxy = x"],
  ["sendemail", "smtpServer = x"], ["pager", "log = x"], ["interactive", "diffFilter = x"], ["uploadpack", "packObjectsHook = x"],
  // keys found by reading `git help config` (round 2)
  ['hook "h"', "command = x"], ['hook "h"', "event = pre-push"], ["hook", "x.command = x"],
  ["gc", "recentObjectsHook = x"], ["gc", "repackFilterTo = x"],
  ['guitool "g"', "cmd = x"], ["imap", "tunnel = x"], ["imap", "host = x"], ["instaweb", "httpd = x"], ["instaweb", "browser = x"],
  ["lfs", "customtransfer.x.path = x"], ["lfs", "url = x"], ['lfs "extension.x"', "clean = x"], ["ssh", "variant = simple"],
  ["extensions", "worktreeConfig = true"], ["extensions", "objectFormat = sha256"],
  ['remote "origin"', "push = x"], ['remote "origin"', "mirror = true"], ['remote "origin"', "fetch = x"],
  ["receive", "procReceiveRefs = x"], ["fetch", "bundleURI = x"], ["transfer", "bundleURI = x"],
  ["bundle", "version = 1"], ['bundle "b"', "uri = x"], ["http", "sslCAInfo = x"], ["gpg", "format = ssh"], ['gpg "x509"', "program = x"],
  ["help", "browser = x"], ["submodule", "alternateLocation = x"], ["trace2", "eventTarget = x"], ["fsmonitor", "socketDir = x"],
  ["core", "unsetenvvars = x"], ["attr", "tree = x"], ['trailer "t"', "cmd = x"], ['mergetool "m"', "cmd = x"], ['difftool "d"', "cmd = x"],
];

for (const [section, line] of EXEC) {
  test(`exec key [${section}] ${line.split(" ")[0]}: added asks, changed value asks`, (t) => {
    const dir = tempRepo(t);
    const before = takeGitSnapshot(dir, HOME);
    fs.appendFileSync(config(dir), `[${section}]\n\t${line}\n`);
    const added = drift(dir, before);
    assert.ok(added.length >= 1, `${section} ${line}`); // core.hooksPath adds a hooks-directory line too
    assert.match(added[0], /^git:config: added /);
    assert.doesNotMatch(added[0], /= x|= true/);
    const mid = takeGitSnapshot(dir, HOME);
    fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace(/= [^\n]*\n$/, "= y\n"));
    assert.match(drift(dir, mid)[0] ?? "", /^git:config: changed /);
  });
}

test("a hook file change still asks", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nevil\n");
  assert.deepEqual(drift(dir, before), ["hooks: changed pre-commit"]);
});

test("a new config file with only non-exec keys is quiet; with an exec key it asks", (t) => {
  const dir = tempRepo(t);
  fs.mkdirSync(path.join(dir, ".git", "worktrees", "w1"), { recursive: true });
  const before = takeGitSnapshot(dir, HOME);
  const f = path.join(dir, ".git", "worktrees", "w1", "config.worktree");
  fs.writeFileSync(f, "[foo]\n\tbar = 1\n");
  assert.deepEqual(drift(dir, before), []);
  fs.writeFileSync(f, "[foo]\n\tbar = 1\n[core]\n\tpager = z\n");
  assert.match(drift(dir, before).join("\n"), /core\.pager/);
});

test("core.bare and core.repositoryformatversion changes ask", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace("bare = false", "bare = true"));
  assert.deepEqual(drift(dir, before), ["git:config: changed core.bare"]);
  fs.appendFileSync(config(dir), "[core]\n\trepositoryformatversion = 1\n");
  assert.match(drift(dir, before)[0], /core\.repositoryformatversion/);
});

test("an unparsable line written with a bookkeeping key still asks; a changed or removed one too", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[branch \"main\"]\n\tvscode-merge-base = o\n[sendpack]\n\t= weird line !!\n[user]\n\tname = a\n");
  const added = drift(dir, before);
  assert.deepEqual(added, ["git:config: added (unparsed lines)"]);
  assert.doesNotMatch(added.join("\n"), /weird/);
  const mid = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace("weird line", "other line"));
  assert.deepEqual(drift(dir, mid), ["git:config: changed (unparsed lines)"]);
  fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace("\t= other line !!\n", ""));
  assert.deepEqual(drift(dir, mid), ["git:config: removed (unparsed lines)"]);
});

test("old-style [core.sub] header and a new config file with an unparsable line still ask", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[core.sub]\n\tfsmonitor = 1\n");
  assert.notDeepEqual(drift(dir, before), []);
  fs.mkdirSync(path.join(dir, ".git", "worktrees", "w1"), { recursive: true });
  const b2 = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(path.join(dir, ".git", "worktrees", "w1", "config.worktree"), "[foo]\n\tbar = 1\n\t= junk\n");
  assert.match(drift(dir, b2).join("\n"), /unparsed lines/);
});

test("comments and blank lines do not count as unparsable", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "\n# note\n; note\n[user]\n\tname = a\n");
  assert.deepEqual(drift(dir, before), []);
});

test("a comment ending in a backslash does not swallow the next section", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[branch \"main\"]\n\tvscode-merge-base = o\n# x \\\n[core]\n\tsshCommand = evil\n");
  assert.match(drift(dir, before).join("\n"), /core\.sshcommand/);
  const b2 = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "; y \\\n[core]\n\tpager = evil2\n");
  assert.match(drift(dir, b2).join("\n"), /core\.pager/);
});

test("a value ending in an escaped backslash does not swallow the next section", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[branch \"main\"]\n\tvscode-merge-base = o\n[user]\n\tname = a\\\\\n[filter \"lfs\"]\n\tclean = evil\n");
  assert.match(drift(dir, before).join("\n"), /filter\.lfs\.clean/);
});

test("a real continuation inside a value still joins", () => {
  assert.deepEqual(parseGitConfig("[a]\n\tb = x\\\n y\n\tc = 1\n"), [["a.b", "x y"], ["a.c", "1"]]);
  assert.deepEqual(parseGitConfig("[a]\n\tb = x\\\r\n y\n\tc = 1\n"), [["a.b", "x y"], ["a.c", "1"]]);
});

test("a bad escape or an open quote is unparsed, not placed", () => {
  assert.equal(parseGitConfigLines("[a]\n\tb = \\q\n\tc = \"x\n").skipped.length, 2);
});

const gitOk = spawnSync("git", ["--version"]).status === 0;
test("differential: key names match git config --list", { skip: !gitOk }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-drift-diff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    "# x \\\n[core]\n\tsshCommand = evil\n",
    "; x \\\n[filter \"lfs\"]\n\tclean = evil\n",
    "[user]\n\tname = a\\\\\n[filter \"lfs\"]\n\tclean = evil\n",
    "[a]\n\tb = x\\\n y\n[core]\n\tpager = p\n",
    "[a]\n\tb = \"q ; # \\\\\"\n[core]\n\tpager = p\n",
    "[a]\n\tb = v # c \\\n[core]\n\teditor = e\n",
    "[a]\n\tb = v ; c \\\\\n[core]\n\teditor = e\n",
    "[Core]\n\tFsMonitor\n[url \"x\\\"y\"]\n\tinsteadOf = z\n",
    "[a] b = 1\n[c] ; d\n\te = 2\n",
    "[a]\n\tb = \"x\\\n y\"\n[core]\n\thooksPath = h\n",
    "[a]\n\tb = x\\\r\n y\r\n[core]\r\n\tpager = p\r\n",
    "[filter \"x\\\r\"]\n\tclean = evil\n",
    "[filter \"x\\\u2028\"]\n\tclean = evil\n",
    "[filter \"x\\\u2029\"]\n\tclean = evil\n",
  ];
  cases.forEach((text, i) => {
    const f = path.join(dir, `c${i}`);
    fs.writeFileSync(f, text);
    const r = spawnSync("git", ["config", "-f", f, "--name-only", "--list"], { encoding: "utf8" });
    assert.equal(r.status, 0, `git rejects case ${i}: ${r.stderr}`);
    assert.deepEqual(parseGitConfig(text).map(([k]) => k), r.stdout.split("\n").filter(Boolean), `case ${i}`);
  });
});

test("a header with an escaped CR, U+2028 or U+2029 is placed; keys under it are not filed under the previous section", (t) => {
  for (const ch of ["\r", "\u2028", "\u2029"]) {
    const dir = tempRepo(t);
    fs.appendFileSync(config(dir), `[filter "x\\${ch}"]\n\tsmudge = a\n`);
    const before = takeGitSnapshot(dir, HOME);
    fs.appendFileSync(config(dir), "\tclean = evil\n");
    assert.match(drift(dir, before).join("\n"), /filter\.x[\s\S]*\.clean/);
  }
});

test("after an unparsable [ line, a following exec key asks", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[broken\n\tpager = evil\n");
  assert.match(drift(dir, before).join("\n"), /unparsed lines/);
  assert.deepEqual(parseGitConfig("[a]\n\tb = 1\n[broken\n\tpager = evil\n"), [["a.b", "1"]]);
});

test("prototype-named sections do not throw and are quiet", async (t) => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const dir = tempRepo(t);
    const before = takeGitSnapshot(dir, HOME);
    fs.appendFileSync(config(dir), `[${name}]\n\tx = 1\n`);
    // git section names allow no underscore, so `[__proto__]` is an unparsable line and fails closed (asks), without throwing
    const expected = name === "__proto__" ? ["git:config: added (unparsed lines)"] : [];
    assert.deepEqual(drift(dir, before), expected, name);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "pf-drift-proto-"));
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    fs.writeFileSync(config(dir), "[core]\n\tbare = false\n");
    const w = new GitDriftWatch();
    w.bind(state, dir, HOME);
    fs.appendFileSync(config(dir), `[${name}]\n\tx = 1\n`);
    assert.deepEqual(new GitDriftWatch().bind(state, dir, HOME), expected, name);
  }
});

test("[constructor] beside a core.fsmonitor plant still asks for core.fsmonitor", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[constructor]\n\tx = 1\n[core]\n\tfsmonitor = /tmp/SECRET\n");
  assert.deepEqual(drift(dir, before), ["git:config: added core.fsmonitor"]);
});

test("push.default added asks", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[push]\n\tdefault = upstream\n");
  assert.deepEqual(drift(dir, before), ["git:config: added push.default"]);
});

test("branch.<b>.merge change plus push.default = upstream asks", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace("merge = refs/heads/main", "merge = refs/heads/other"));
  fs.appendFileSync(config(dir), "[push]\n\tdefault = upstream\n");
  assert.match(drift(dir, before).join("\n"), /push\.default/);
});

test("rebase.instructionFormat added asks (it can inject exec todo lines)", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[rebase]\n\tinstructionFormat = %s%nexec x\n");
  assert.deepEqual(drift(dir, before), ["git:config: added rebase.instructionformat"]);
});

test("[Rebase] InstructionFormat mixed case added asks", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[Rebase]\n\tInstructionFormat = %s%nexec x\n");
  assert.equal(drift(dir, before).length, 1);
});

test("sequence.editor added asks", (t) => {
  const dir = tempRepo(t);
  const before = takeGitSnapshot(dir, HOME);
  fs.appendFileSync(config(dir), "[sequence]\n\teditor = x\n");
  assert.equal(drift(dir, before).length, 1);
});
