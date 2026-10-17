// R10 P1 item 4 (d): quoted pattern args are never classified as external paths. Reproduced first through the layers:
// - the permission system's bash external-directory gate (pi-permission-system token classifier) names any word that starts with `/` as an
//   external path unless its pattern-first table knows the command: it has no `git` row (`git log -S '/x/'`, `-G`, `--grep`, `-L '/a/,/b/:f'`)
//   and reads only the first two letters of a short-option cluster (`grep -ne '/x/'`). Its ask reaches the review link as surface
//   external_directory(_read) with a bash payload; the link had no allow for a bash external-directory ask (readRootPathAllow returns null for
//   bash, the surface is not a review surface), so it deferred to the dialog. Fixed in the review link: "pattern-arg" when every external path
//   the gate names is a pattern operand (permoverlay patternArgPaths) and no other word of the line names it.
// - the overlay (checkToolCall): a `git log -S`/`-G`/`--grep` value that names a toolchain probe dir asked (the probe narrowing saw it as a
//   path word); scriptOperands now knows those values, so they drop out of the path words like grep/rg patterns do.
// `git log -L <range>:<file>`: only <range> is a non-path; <file> stays a path candidate (finding F).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules } from "../timeoutallow.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-pattern-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
// a child runs in its own round worktree (the foreman's workspace is write-protected for children)
const wt = path.join(w, "ws.worktrees", "r1");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [path.join(ws, "src"), path.join(wt, "src"), ag]) fs.mkdirSync(d, { recursive: true });
for (const r of [ws, wt]) fs.writeFileSync(path.join(r, "src", "x.ts"), "x\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ctx = (role: "main" | "child"): MatchCtx => (role === "main" ? { cwd: ws, home, platform: process.platform, role } : { cwd: wt, home, platform: process.platform, role, roundRoots: [wt] });
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules, "bash", { command }, ctx(role))?.kind ?? "pass";

const registry: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
const session = (): ReviewSession => ({ isChild: false, cwd: ws, provider: "a", config: () => ({}), registry, intent: "", bashRules: () => bashRules(baseline, {}) });
let n = 0;
/** The ask the permission system's bash external-directory gate raises: the command, the uncovered external paths as evidence. */
const gateAsk = (command: string, paths: string[], surface = "external_directory", forwarding = false) => ({
  requestId: `p${++n}`,
  source: "tool_call",
  agentName: forwarding ? "builder" : null,
  toolName: "bash",
  command,
  ...(forwarding ? { forwarding: true } : {}),
  payload: { kind: "bash_external_directory", request: { surface, toolName: "bash", value: command }, evidence: [{ label: "working directory", text: ws }, ...paths.map((p) => ({ label: "external path", text: p }))] },
});
const link = async (command: string, paths: string[], surface?: string, forwarding?: boolean): Promise<string> => {
  const r = new ForemanReview();
  r.upsert("s", session());
  return (await r.authorize("s", gateAsk(command, paths, surface, forwarding) as never)).kind;
};

// [command, the external paths the gate names]
const OPEN: [string, string[]][] = [
  ["git log -L '/start/,/end/:src/x.ts'", ["/start/,/end/:src/x.ts"]],
  ["git log -S '/api/v1/' --oneline", ["/api/v1/"]],
  ["git log -G '/usr/.*bin/' -p -- src", ["/usr/.*bin/"]],
  ["git log --grep '/r9/' --oneline", ["/r9/"]],
  ["git log --grep=/r9/ --oneline", ["/r9/"]],
  ["git log --oneline -S /x/y -G /a/b", ["/x/y", "/a/b"]],
  ["grep -ne '/foo/' src/x.ts", ["/foo/"]],
  ["grep -n -e '/foo/' -e '/bar/' src", ["/foo/", "/bar/"]],
  ["rg -e '/foo/bar' src", ["/foo/bar"]],
  ["sed -n '/a/,/b/p' src/x.ts", ["/a/,/b/p"]],
  ["git show HEAD:src/x.ts | sed -n '/start/,/end/p' | head -20", ["/start/,/end/p"]],
  ["cd src && git log -S '/api/' --oneline | head", ["/api/"]],
];
for (const [cmd, paths] of OPEN) {
  test(`expected-open (R10d): ${cmd} (review link: pattern-arg; overlay pass for foreman and child)`, { skip: !posix }, async () => {
    assert.equal(await link(cmd, paths), "allow", "external_directory");
    assert.equal(await link(cmd, paths, "external_directory_read"), "allow", "external_directory_read");
    assert.equal(await link(cmd, paths, "external_directory", true), "allow", "forwarded child ask");
    assert.equal(sh("main", cmd), "pass", "overlay foreman");
    assert.equal(sh("child", cmd), "pass", "overlay child");
  });
}

test("expected-open (R10d): a git log -S/-G/--grep value naming a probe dir is a pattern, not a probe path word (overlay)", { skip: !posix }, () => {
  for (const cmd of ["git log -S /usr/local/bin --oneline", "git log -G '/opt/homebrew/bin' -p", "git log --grep /usr/bin"]) {
    assert.equal(sh("main", cmd), "pass", cmd);
    assert.equal(sh("child", cmd), "pass", cmd);
  }
});

test("(decision: ask) a probe dir after `--` or as the <file> of `git log -L` stays a path word (overlay)", { skip: !posix }, () => {
  for (const cmd of ["git log -S x -- /usr/local/bin", "git log -L '1,5:/usr/local/bin/x'", "git log -L '/a/,/b/:/usr/local/bin/x'"]) {
    assert.equal(sh("main", cmd), "ask", cmd);
    assert.equal(sh("child", cmd), "ask", cmd);
  }
});

const ASK: [string, string[]][] = [
  // a real external path argument next to a pattern
  ["grep -e '/x/' /etc/hosts", ["/x/", "/etc/hosts"]],
  ["git log -S '/x/' -- /etc/hosts", ["/x/", "/etc/hosts"]],
  // the same word as a pattern and as a file operand
  ["grep -e /etc/hosts /etc/hosts", ["/etc/hosts"]],
  // a sed script that writes or reads a file keeps its path
  ["sed -n '/a/w /etc/x' src/x.ts", ["/a/w /etc/x"]],
  ["sed -n '/a/w /etc/x' src/x.ts", ["/etc/x"]],
  ["sed '/a/r /etc/hosts' src/x.ts", ["/a/r /etc/hosts"]],
  ["sed -n -e '/a/,/b/p' -e 'w /etc/x' src/x.ts", ["/a/,/b/p"]],
  // -L: the <file> part stays a path
  ["git log -L '/a/,/b/:/etc/hosts'", ["/a/,/b/:/etc/hosts"]],
  ["git log -L '/a/,/b/:../other/x.ts'", ["/a/,/b/:../other/x.ts"]],
  ["git log -L '/a/,/b/:~/x.ts'", ["/a/,/b/:~/x.ts"]],
  // a path the gate names that is no pattern of the line
  ["git log -S '/x/' --oneline", ["/y/"]],
  // text that may become a path: echo, xargs, substitution, a non-pure command
  ["echo /x/ | xargs cat", ["/x/"]],
  ["grep -e /x/ src | xargs cat", ["/x/"]],
  ["cat $(grep -e /x/ src)", ["/x/"]],
  ["grep -e /x/ <(cat /etc/hosts)", ["/x/"]],
  ["git log -S /x/ && python3 x.py /x/", ["/x/"]],
  ["git -C /x/ log -S /x/", ["/x/"]],
  // a redirect target
  ["grep -e /x/ src > /var/out", ["/x/", "/var/out"]],
  ["grep -e /var/out src > /var/out", ["/var/out"]],
  // a writing git subcommand, an env or wrapper prefix
  ["git commit -m x -S /x/", ["/x/"]],
  ["X=1 grep -e /x/ src", ["/x/"]],
  ["env grep -e /x/ src", ["/x/"]],
  // no external path evidence
  ["grep -e /x/ src", []],
];
for (const [cmd, paths] of ASK) {
  test(`(decision: ask) ${cmd} [gate names ${paths.join(", ") || "nothing"}] (review link defers)`, { skip: !posix }, async () => {
    assert.notEqual(await link(cmd, paths), "allow");
    assert.notEqual(await link(cmd, paths, "external_directory_read"), "allow");
  });
}

test("(decision: ask) a read-tool external-directory ask is not a pattern-arg (review link)", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session());
  const d = { requestId: "t1", source: "tool_call", agentName: null, toolName: "read", path: "/x/", payload: { kind: "external_directory", request: { surface: "external_directory_read", toolName: "read", value: "/x/" }, evidence: [] } };
  assert.notEqual((await r.authorize("s", d as never)).kind, "allow");
});
