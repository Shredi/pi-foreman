// Git drift asks only for changes that can run a program or redirect git (hooks, exec-capable config keys); other keys update the baseline silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffGitSnapshots, takeGitSnapshot } from "../gitdrift.ts";

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
];

for (const [section, line] of EXEC) {
  test(`exec key [${section}] ${line.split(" ")[0]}: added asks, changed value asks`, (t) => {
    const dir = tempRepo(t);
    const before = takeGitSnapshot(dir, HOME);
    fs.appendFileSync(config(dir), `[${section}]\n\t${line}\n`);
    const added = drift(dir, before);
    assert.ok(added.length >= 1, `${section} ${line}`); // core.hooksPath adds a hooks-directory line too
    assert.match(added[0], /^git:config: added /);
    assert.doesNotMatch(added[0], /= x/);
    const mid = takeGitSnapshot(dir, HOME);
    fs.writeFileSync(config(dir), fs.readFileSync(config(dir), "utf8").replace(/= (!x|x|always)\n$/, "= y\n"));
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
