// The entry condition of the read question (readclear.ts readClearEntry), table-driven over the gate's real outcome (gateEvaluate): which calls
// reach the judge and which keep today's route. The condition is built from facts the gate has today; it is no safety boundary.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitFacts } from "../defaults.ts";
import { DANGER_RULES } from "../defaults.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { READ_CLEAR_MAX_LINE, readClearEntry, shellIsBash } from "../readclear.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-readclear-entry-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
fs.mkdirSync(path.join(wt, "src"), { recursive: true });
fs.mkdirSync(scr, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true };
const facts: GitFacts = { currentBranch: () => "feature/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const env = baseFloorEnv(wt, { home: path.join(base, "home") });

type Opts = { tool?: string; shellBash?: boolean; child?: boolean };
/** The gate's outcome for `line`, and whether the read question's entry condition holds. `reached` is false when the gate decided before the mode step. */
function probe(line: string, o: Opts = {}): { entry: boolean; undecided: boolean; dangers: string[] } {
  const tool = o.tool ?? "bash";
  const r = o.child ? { ...roots, child: true } : roots;
  const out = gateEvaluate(tool, { command: line }, wt, { env: () => env, roots: () => r, facts });
  const undecided = out.result === undefined && out.danger !== null;
  const entry = undecided && out.segments !== undefined && readClearEntry({ tool, text: line, segments: out.segments, dangers: out.dangers ?? [], shellBash: () => o.shellBash ?? true }, env);
  return { entry, undecided, dangers: out.dangers ?? [] };
}

const REACH: [string, string][] = [
  ["a pipeline with a glob in a grep operand", "sed -n '1,40p' src/a.ts | grep -n foo src/*.ts | cut -c1-80 | head -20"],
  ["the same pipeline after a cd", "cd src && grep -rn foo ./*.ts | head -20"],
  ["python3 reading its program from a heredoc", "python3 - <<'EOF'\nimport os\nprint(sorted(os.listdir('.')))\nEOF"],
  ["a heredoc program followed by a grep", "python3 - <<'EOF'\nprint(1)\nEOF\ngrep -n foo src/*.ts"],
  ["node -e with a literal", "node -e \"console.log(require('fs').readdirSync('.'))\""],
  ["a for loop over a glob", "for f in src/*.ts; do grep -n foo \"$f\"; done"],
];

for (const [name, line] of REACH) {
  test(`reaches the read question: ${name}`, () => {
    const p = probe(line);
    assert.deepEqual([p.undecided, p.dangers], [true, ["danger-opaque"]], "the gate leaves it to the mode step with danger-opaque alone");
    assert.equal(p.entry, true);
  });
}

test("reaches the read question for a child session too", () => {
  assert.equal(probe("grep -n foo src/*.ts", { child: true }).entry, true);
});

test("does not reach it: another dangerous-class entry matches a readable segment next to an unreadable one", () => {
  const p = probe("gh pr merge 1; grep x src/*.ts");
  assert.equal(p.undecided, true);
  assert.ok(p.dangers.includes("danger-opaque") && p.dangers.includes("danger-forge"), p.dangers.join());
  assert.equal(p.entry, false);
});

test("does not reach it: the powershell tool", () => {
  assert.equal(probe("grep -n foo src/*.ts", { tool: "powershell" }).entry, false);
});

test("does not reach it: an MCP tool, a path tool and a launch are no bash line", () => {
  for (const [tool, input] of [["mcp__srv__act", { x: 1 }], ["write", { path: path.join(base, "outside", "f"), content: "x" }], ["subagent", { agent: "builder", task: "x", cwd: path.join(base, "outside") }]] as const) {
    const out = gateEvaluate(tool, input, wt, { env: () => env, roots: () => roots, facts });
    assert.equal(out.segments, undefined, tool);
    assert.equal(readClearEntry({ tool, text: JSON.stringify(input), segments: [], dangers: out.dangers ?? (out.danger ? [out.danger.name] : []), shellBash: () => true }, env), false, tool);
  }
});

test("does not reach it: a raw secret-path token in an operand, a -c string and a heredoc body (lines the floors do not read)", () => {
  const secret = path.join(base, "home", ".ssh", "id_rsa");
  for (const line of [
    'f=~/.ssh/id_rsa; cat "$f"',
    'for f in ~/.ssh/id_rsa; do cat "$f"; done',
    `python3 -c "print(open('${secret}').read())"`,
    `python3 - <<'EOF'\nprint(open('${secret}').read())\nEOF`,
  ]) {
    const p = probe(line);
    assert.equal(p.undecided, true, line);
    assert.equal(p.entry, false, line);
  }
});

test("does not reach it: a split-literal case of the shared fixture given inline", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "split-literal-cases.json"), "utf8")) as { deny: string[] };
  const text = `python3 - <<'EOF'\n${cases.deny.find((c) => /\+/.test(c)) ?? cases.deny[0]}\nEOF`;
  const out = gateEvaluate("bash", { command: text }, wt, { env: () => env, roots: () => roots, facts });
  // whatever the gate does with it, the predicate on the raw line alone keeps it from the judge
  assert.equal(readClearEntry({ tool: "bash", text, segments: out.segments ?? [], dangers: ["danger-opaque"], shellBash: () => true }, env), false);
});

test("does not reach it: a line longer than the bound", () => {
  const long = `grep -n foo src/*.ts # ${"x".repeat(READ_CLEAR_MAX_LINE)}`;
  assert.equal(probe(long).entry, false);
  assert.equal(probe(`grep -n foo src/*.ts # ${"x".repeat(100)}`).entry, true);
});

test("does not reach it: a non-bash shellPath and the sh fallback", () => {
  assert.equal(probe("grep -n foo src/*.ts", { shellBash: false }).entry, false);
  assert.equal(shellIsBash(undefined, () => ({ shell: "sh", args: ["-c"] })), false, "the sh fallback");
  assert.equal(shellIsBash("/usr/bin/zsh", () => ({ shell: "/usr/bin/zsh", args: ["-c"] })), false, "a zsh shellPath");
  assert.equal(shellIsBash("/opt/x/fish", () => ({ shell: "/opt/x/fish", args: ["-c"] })), false);
  assert.equal(shellIsBash("/nope", () => { throw new Error("Custom shell path not found"); }), false, "a throw");
  assert.equal(shellIsBash("C:\\Windows\\System32\\bash.exe", () => ({ shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"], commandTransport: "stdin" })), false, "legacy WSL bash on stdin");
  assert.equal(shellIsBash(undefined, () => ({ shell: "/bin/bash", args: ["-c"] })), true);
  assert.equal(shellIsBash("/opt/homebrew/bin/bash", () => ({ shell: "/opt/homebrew/bin/bash", args: ["-c"] })), true);
  assert.equal(shellIsBash("C:\\Program Files\\Git\\bin\\bash.exe", () => ({ shell: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] })), true);
});

test("does not reach it: a redirect that can write, or a writing wrapper the parser saw", () => {
  for (const line of ["grep foo src/*.ts > out.txt", "grep foo src/*.ts 1<>x", "grep foo src/*.ts >| x", "grep foo src/*.ts >> out.txt", "grep foo src/*.ts &> out.txt", "grep foo src/*.ts | tee x"]) {
    const p = probe(line);
    // the gate may decide some of these earlier (a write outside); then they never reach the mode step either
    assert.equal(p.entry, false, line);
  }
  const wrapper = probe("grep foo src/*.ts | tee x");
  assert.equal(wrapper.entry, false);
});

// one readable segment per dangerous-class entry next to an unreadable one; the two entries that judge no bash line are covered by the tool test above
const OTHER_ENTRY: Record<string, string> = {
  "danger-write-outside": "cp a.txt /etc/b; grep x src/*.ts",
  "danger-deploy": "kubectl apply -f x.yaml; grep x src/*.ts",
  "danger-forge": "gh pr merge 1; grep x src/*.ts",
  "danger-publish": "npm publish; grep x src/*.ts",
  "danger-net-write": "curl -X POST -d x https://example.com; grep x src/*.ts",
  "danger-install": "npm install left-pad; grep x src/*.ts",
  "danger-git": "git reset --hard; grep x src/*.ts",
  "danger-process": "kill 1; grep x src/*.ts",
  "danger-inject": "herdr pane send-text 1-2 hi; grep x src/*.ts",
};
const NOT_BASH_ENTRIES = ["danger-opaque", "danger-mcp-act", "danger-launch-outside"];

test("does not reach it: every other dangerous-class entry on a readable segment keeps the call from the judge (all entries of DANGER_RULES)", () => {
  assert.deepEqual([...Object.keys(OTHER_ENTRY), ...NOT_BASH_ENTRIES].sort(), DANGER_RULES.map((r) => r.name).sort(), "a new dangerous-class entry needs a case here");
  const bad: string[] = [];
  for (const [name, line] of Object.entries(OTHER_ENTRY)) {
    const p = probe(line);
    // some entries are decided earlier by a rule of the gate (then the line never reaches the mode step); the predicate alone still says no
    const out = gateEvaluate("bash", { command: line }, wt, { env: () => env, roots: () => roots, facts });
    const alone = readClearEntry({ tool: "bash", text: line, segments: out.segments ?? [], dangers: ["danger-opaque", name], shellBash: () => true }, env);
    if (alone || p.entry || (p.undecided && (!p.dangers.includes("danger-opaque") || !p.dangers.includes(name)))) bad.push(`${name}: undecided ${p.undecided}, entries ${p.dangers.join()}, entry ${p.entry}, alone ${alone}`);
  }
  assert.deepEqual(bad, []);
});

test("the redirect clause and the writing_wrapper clause on the parsed segments: every writing op, the null device and a duplication are told apart", () => {
  const text = "grep foo src/*.ts";
  const out = gateEvaluate("bash", { command: text }, wt, { env: () => env, roots: () => roots, facts });
  const seg = out.segments![0];
  const entry = (patch: Partial<typeof seg>) => readClearEntry({ tool: "bash", text, segments: [{ ...seg, ...patch }], dangers: ["danger-opaque"], shellBash: () => true }, env);
  assert.equal(entry({}), true);
  for (const op of [">", ">>", "&>", "&>>", "<>", ">|"] as const) {
    assert.equal(entry({ redirects: [{ op, fd: null, target: "out.txt" }] }), false, op);
    assert.equal(entry({ redirects: [{ op, fd: null, target: "/dev/null" }] }), true, `${op} to the null device`);
  }
  assert.equal(entry({ redirects: [{ op: "<", fd: null, target: "a.txt" }] }), true);
  assert.equal(entry({ redirects: [{ op: "dup", fd: "2", target: "1" }] }), true);
  assert.equal(entry({ opaque: "writing_wrapper" }), false);
  assert.equal(entry({ opaque: "glob_target" }), true);
});

test("a redirect that cannot write does not keep the line from the judge: input, the null device, an fd duplication", () => {
  for (const line of ["grep foo src/*.ts < src/a.ts", "grep foo src/*.ts 2>/dev/null", "grep foo src/*.ts > /dev/null 2>&1", "grep foo src/*.ts 2>&1"]) assert.equal(probe(line).entry, true, line);
});
