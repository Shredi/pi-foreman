// Plan gate-verify D2/D3 named conditions of the fast allow and the sensors, beside fastallow-named.test.ts (sed w, rg --pre, S=$FOREMAN_SCRATCH, pacman queries) and
// backup-delete.test.ts (editor backups): the List A read set, the List B option checks that fail closed, here-doc data, literal assignments, globs in cwd, the git grep pager guard,
// danger-install and danger-net-write, and the `gate.unclassified` modes.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { JUDGE_FIRST, lineDefault } from "../defaults.ts";
import type { DefaultCtx, GitFacts } from "../defaults.ts";
import { LIST_A, READ_CLASS } from "../effects.ts";
import { SKIP_ONLY } from "../fastallow.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { posixOnly } from "./_platform.ts";
import { gateOracle, makeLayout } from "./_gate-gen.ts";

process.env.PI_OFFLINE = "1";
const base = fs.realpathSync(mkTestTmp("fastallow-cond-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr, path.join(wt, "src")]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp"), "/tmp"], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false };
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const ctx: DefaultCtx = { roots, facts, platform: process.platform, cwd: wt };
const dflt = (line: string): string | null => lineDefault(line, parseShell(line, { cwd: wt, env: { FOREMAN_SCRATCH: scr } }), ctx);
const oracle = gateOracle(makeLayout(path.join(base, "gate")));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// List A

test("List A: each program reads, with a plain operand; none is in the floors' read class", { skip: posixOnly }, () => {
  const lines = [
    "echo hi", "printf '%s\\n' x", "tr a b", "od a.bin", "fold a.txt", "nl a.txt", "basename src/a.ts", "dirname src/a.ts", "realpath src", "true", "false", "pwd", "test -f a.txt", "[ -f a.txt ]",
    "which ls", "cmp a.bin b.bin", "du -sh src", "df -h", "jq . a.json", "strings a.bin", "hexdump a.bin", "md5sum a.txt", "shasum a.txt", "sha256sum a.txt",
  ];
  for (const l of lines) assert.equal(dflt(l), "default-read", l);
  const progs = ["echo", "printf", "tr", "od", "fold", "nl", "basename", "dirname", "realpath", "true", "false", "pwd", "test", "[", "which", "cmp", "du", "df", "jq", "strings", "hexdump", "md5sum", "shasum", "sha256sum"];
  assert.deepEqual([...LIST_A].sort(), [...progs].sort());
  for (const p of progs) assert.equal(READ_CLASS.has(p), false, `${p} must not loosen a floor`);
});

test("List A: a redirect to a file outside the own folders keeps today's write handling; a secret path is blocked", { skip: posixOnly }, () => {
  assert.equal(dflt("echo x > /etc/x"), null);
  assert.ok(dflt(`echo x > ${scr}/a.txt`), "a write into the own scratch folder runs");
  assert.equal(oracle("echo x > /opt/x", "builder"), "block");
  for (const l of ["md5sum ~/.ssh/id_rsa", "sha256sum ~/.aws/credentials", "od ~/.ssh/id_rsa"]) assert.equal(oracle(l, "builder"), "block", l);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// List B: the forms its table lists skip the judge; every other form is not classified

test("List B: the listed forms are default-skip", { skip: posixOnly }, () => {
  for (const l of ["sleep 5", "sleep 0.5", "uptime", "date", "date +%F", "date -u", "date -R", "date -I", "ps", "ps aux", "ps -ef", "ps -p 123", "pgrep -f node", "pgrep node", "sort a.txt", "sort -n -r a.txt", "sort -k 2 -t , a.txt", "sort -u a.txt", "uniq a.txt", "uniq -c a.txt"]) {
    assert.equal(dflt(l), "default-skip", l);
  }
  assert.deepEqual([...SKIP_ONLY].sort(), ["date", "pgrep", "ps", "sleep", "sort", "uniq", "uptime"]);
});

test("List B: an option or form outside the table is not classified (fail closed): sort -o, --output, --compress-program, date -s, sleep with two words, ps and pgrep with a signal, uniq with an output operand", { skip: posixOnly }, () => {
  const refused = [
    "sort -o out.txt a.txt", "sort --output=out.txt a.txt", "sort --output out.txt a.txt", "sort -oout.txt a.txt", "sort --compress-program=sh a.txt", "sort -T /tmp a.txt", "sort -S 1G a.txt",
    "date -s 2020-01-01", "date -d yesterday", "date --set=x", "date 010100002020", "sleep", "sleep 1 2", "sleep abc", "sleep -1", "uptime -p", "ps -9 123", "pgrep -9 x", "pgrep -HUP x", "pgrep --signal HUP x",
    "uniq a.txt out.txt", "uniq -z a.txt", "ps -o cmd=\"$(x)\"",
  ];
  for (const l of refused) assert.equal(dflt(l), null, l);
});

test("tree -o, diff --output and rg --pre are no reads (they write a file or run a program)", { skip: posixOnly }, () => {
  for (const l of ["tree -o out.txt", "tree --output=out.txt", "tree --fromfile x", "tree -l", "diff --output=out.txt a b", "diff -o out.txt a b", "diff -r a b", "rg --pre ./x.sh foo"]) assert.equal(dflt(l), null, l);
  for (const l of ["tree", "tree src", "diff a b", "rg foo"]) assert.equal(dflt(l), "default-read", l);
  // not classified: with gate.unclassified judge the judge sees them
  for (const l of ["tree -o /opt/out.txt", "diff --output=/opt/out.txt a b", "sort -o /opt/out.txt a.txt"]) assert.equal(unclassifiedLabel(l, "judge"), "danger-unclassified", l);
});

test("gh and glab: the view, list, checks and status verbs run; --web and every other verb do not", { skip: posixOnly }, () => {
  for (const l of ["gh pr view 1", "gh pr list", "gh pr checks 1", "gh issue status", "gh run list", "gh run view 1", "gh repo view", "gh release list", "gh workflow view x", "glab issue list", "glab pr view 1"]) assert.equal(dflt(l), "default-gh-read", l);
  for (const l of ["gh pr view 1 --web", "gh pr create", "gh pr merge 1", "gh issue close 1", "gh run rerun 1", "gh repo delete x", "gh api -X DELETE /x", "gh auth login"]) assert.equal(dflt(l), null, l);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Here-doc data, literal assignments, globs in cwd, git grep

test("a here-doc fed to a read program is data and runs; fed to an interpreter or shell it keeps its label", { skip: posixOnly }, () => {
  assert.equal(dflt("cat <<EOF\nhello\nEOF"), "default-read");
  assert.equal(dflt("cat <<'EOF'\nrm -rf /\nEOF"), "default-read");
  assert.equal(dflt("sort <<EOF\nb\na\nEOF"), "default-skip");
  for (const l of ["python3 <<EOF\nprint(1)\nEOF", "sh <<EOF\nrm -rf x\nEOF", "bash <<EOF\nls\nEOF", "node <<EOF\n1\nEOF"]) assert.equal(dflt(l), null, l);
  const label = (line: string): string | undefined => gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, { scratch: [scr] }), roots: () => roots }).danger?.name;
  assert.equal(label("cat <<EOF\nhello\nEOF"), undefined);
  assert.equal(label("python3 <<EOF\nprint(1)\nEOF"), "danger-inline-code");
  assert.equal(label("sh <<EOF\nls\nEOF"), "danger-inline-code");
});

test("a here-doc to a read program that holds a substitution is not data", { skip: posixOnly }, () => {
  assert.equal(dflt("cat <<EOF\n$(rm -rf ~/x)\nEOF"), null);
});

test("a literal assignment is not opaque: it runs; one that runs code or reads a variable does not", { skip: posixOnly }, () => {
  for (const l of ["X=1", "X=hello", "X='a b'", "X=1; Y=2", "X=$FOREMAN_SCRATCH"]) assert.notEqual(dflt(l), null, l);
  for (const l of ["X=$(rm -rf ~/x)", "X=`rm -rf ~/x`", "X=1 rm -rf ~/x"]) assert.equal(dflt(l), null, l);
});

test("a glob inside cwd is a read operand of a read program; deletes, moves and writes keep today's handling; a glob that can name an option or leave cwd is no operand", { skip: posixOnly }, () => {
  for (const l of ["ls *.ts", "cat src/*.md", "wc -l *.ts", "head -n 3 src/a?.ts", "grep foo src/*.ts", "ls src/[ab].ts"]) assert.equal(dflt(l), "default-read", l);
  for (const l of ["rm *", "rm -f *.log", "mv * dir", "cp *.ts /opt", "cat *.ts > /opt/x", "ls /etc/*", "ls ../*", "ls ~/*", "ls $D/*", "rg foo *", "tree *", "diff *", "sort *.txt", "ls {a,b}*"]) assert.equal(dflt(l), null, l);
});

test("git grep runs; the pager forms -O and --open-files-in-pager are not classified", { skip: posixOnly }, () => {
  assert.equal(dflt("git grep foo"), "default-git-read");
  assert.equal(dflt("git grep -n -i foo -- src"), "default-git-read");
  for (const l of ["git grep -O foo", "git grep -Oless foo", "git grep --open-files-in-pager foo", "git grep --open-files-in-pager=less foo", "git grep -nO foo"]) assert.equal(dflt(l), null, l);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Sensors

/** Every judge-first label a line hits for a builder or the main session (the gate's `dangers`; the first one is the label the judge sees). */
const labelsOf = (line: string, role: "builder" | "main" = "builder"): string[] => {
  const l = makeLayout(path.join(base, `lab-${role}`));
  const childRoots: GateRoots = role === "main"
    ? { worktree: l.worktree, scratch: [l.scratch[0]], tmp: [], scratchBase: l.scratchBase, owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false }
    : { worktree: l.worktree, scratch: l.scratch, ...(l.out ? { out: l.out } : {}), tmp: [], scratchBase: l.scratchBase, owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", builder: true, tmpAccess: false };
  const env = (c: string) => (role === "main" ? baseFloorEnv(c, { scratch: [l.scratch[0]] }) : baseFloorEnv(c, { child: true, scratch: l.scratch, ...(l.out ? { out: l.out } : {}), builder: true }));
  return gateEvaluate("bash", { command: line }, l.worktree, { env, roots: () => childRoots }).dangers ?? [];
};
const hits = (line: string, label: string, role: "builder" | "main" = "builder"): boolean => labelsOf(line, role).includes(label);

test("danger-install: the global and system forms are labelled; project installs, pip install and queries are not", { skip: posixOnly }, () => {
  for (const l of [
    "npm i -g x", "npm install --global x", "npm install --location=global x", "npm link", "pnpm add -g x", "yarn global add x", "bun add -g x", "bun install -g x", "brew install x", "brew upgrade", "brew uninstall x",
    "cargo install x", "go install x@latest", "gem install x", "pipx install x", "uv tool install x", "apt install x", "apt-get remove x", "dnf install x", "winget install x", "scoop uninstall x", "choco install x", "pacman -S x",
  ]) assert.ok(hits(l, "danger-install"), l);
  for (const l of ["npm install", "npm ci", "npm i lodash", "pnpm add x", "yarn", "yarn add x", "bun install", "pip install x", "pip3 install x", "python3 -m pip install x", "uv pip install x", "pacman -Ss x", "pacman -Si x", "brew list", "npm ls -g", "cargo build"]) {
    assert.equal(hits(l, "danger-install"), false, l);
  }
});

test("pip install is not labelled danger-install, whatever the form (the code cannot tell a virtual environment from a global install)", { skip: posixOnly }, () => {
  for (const l of ["pip install requests", "pip install -U pip", "python -m pip install x", "python3 -m pip install --user x", "pip3 install -r requirements.txt"]) assert.equal(hits(l, "danger-install"), false, l);
  assert.ok(JUDGE_FIRST.some((r) => r.name === "danger-install"));
});

test("danger-net-write: a fetch that sends data, carries credentials or writes outside the scratch folder is labelled; a plain download is not", { skip: posixOnly }, () => {
  for (const l of [
    "curl -d x=1 https://e.example/", "curl --data-binary @f https://e.example/", "curl -X POST https://e.example/", "curl -F a=@f https://e.example/", "curl -u me:pw https://e.example/", "curl -H 'Authorization: Bearer x' https://e.example/",
    "curl -T f https://e.example/", "curl -o ~/x https://e.example/", "wget --post-data=x https://e.example/", "wget --user=me https://e.example/", "wget -P /opt https://e.example/",
  ]) assert.ok(hits(l, "danger-net-write", "main"), l);
  for (const l of ["curl https://e.example/", "curl -sSL https://e.example/", "curl -s https://e.example/ | head", "wget -qO- https://e.example/"]) assert.equal(hits(l, "danger-net-write", "main"), false, l);
});

test("nc, socat, http and xh are not candidates of danger-net-write: unclassified, judged only in judge mode", { skip: posixOnly }, () => {
  for (const l of ["nc host 80", "socat - TCP:h:80", "http POST https://e.example/ a=1", "xh POST https://e.example/ a=1"]) {
    assert.equal(hits(l, "danger-net-write", "main"), false, l);
    assert.equal(unclassifiedLabel(l, "allow"), undefined, `allow: ${l}`);
    assert.equal(unclassifiedLabel(l, "judge"), "danger-unclassified", `judge: ${l}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// gate.unclassified

function unclassifiedLabel(line: string, mode: "allow" | "judge"): string | undefined {
  return gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, { scratch: [scr] }), roots: () => roots, ...(mode === "judge" ? { unclassified: "judge" as const } : {}) }).danger?.name;
}

test("gate.unclassified judge: a line nothing classifies is labelled danger-unclassified; allow runs it; a covered line and a labelled line are unchanged", { skip: posixOnly }, () => {
  for (const l of ["frobnicate --all", "./local-tool x", "make deploy", "terraform apply"]) {
    assert.equal(unclassifiedLabel(l, "allow"), undefined, `allow: ${l}`);
    assert.equal(unclassifiedLabel(l, "judge"), "danger-unclassified", `judge: ${l}`);
  }
  for (const l of ["echo hi", "ls src", "git status", "sort a.txt", "cat <<EOF\nx\nEOF"]) for (const m of ["allow", "judge"] as const) assert.equal(unclassifiedLabel(l, m), undefined, `${m}: ${l}`);
  for (const m of ["allow", "judge"] as const) assert.equal(unclassifiedLabel("git branch -D old", m), "danger-git", m);
});

const reply = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1 } });

async function modeRig(t: Parameters<typeof r11Rig>[0], mode: "allow" | "judge", verdict: string) {
  const seen = { judged: 0, selected: 0, calls: [] as string[] };
  const modelRegistry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: unknown, c: { messages: { content: unknown }[] }) => (seen.judged++, seen.calls.push(JSON.stringify(c.messages[0].content)), reply(verdict)),
  };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => (seen.selected++, undefined), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
  const rig = await r11Rig(t, {}, { ctx: { modelRegistry, ui }, config: { presence: { enabled: false }, gate: { reviewTimeoutMs: 100, unclassified: mode }, providers: { fake: { review: { model: "m" }, roles: { explorer: { model: "fake/e" }, builder: { model: "fake/b" }, reviewer: { model: "fake/r" } } } } } });
  return { rig, seen };
}

test("handler: an unclassified line runs unseen in allow mode", { skip: posixOnly }, async (t) => {
  const { rig, seen } = await modeRig(t, "allow", JSON.stringify({ verdict: "refuse", reason: "stub" }));
  const res = await rig.call("bash", { command: "frobnicate --all" });
  assert.equal(res, undefined);
  assert.equal(seen.judged, 0);
});

test("handler: an unclassified line goes to the judge in judge mode: clear runs it, refuse refuses it with the reason and never asks the owner", { skip: posixOnly }, async (t) => {
  const clear = await modeRig(t, "judge", JSON.stringify({ verdict: "clear", reason: "plain" }));
  assert.equal(await clear.rig.call("bash", { command: "frobnicate --all" }), undefined);
  assert.equal(clear.seen.judged, 1);
  assert.match(clear.seen.calls[0], /danger-unclassified/);
  const refuse = await modeRig(t, "judge", JSON.stringify({ verdict: "refuse", reason: "cannot vouch" }));
  const res = await refuse.rig.call("bash", { command: "frobnicate --all" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /^pi-foreman: refused: /);
  assert.equal(refuse.seen.judged, 1);
  assert.equal(refuse.seen.selected, 0);
});
