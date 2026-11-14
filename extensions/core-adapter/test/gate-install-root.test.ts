// Guard round 1, step 3: `install-root-write`. A write the gate can name into the Pi install root, a bundled package root, the global npm root or the harness
// package root, from outside the session's own worktree, goes to the owner (mode deny refuses, headless refuses, a child's write outside is refused as before).
// Reads and test runs stay allowed. Each asked row has an unasked row beside it. The "open" rows assert the verdict of today for a change that names no path.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { slashForm } from "../pathnorm.ts";
import { parseRule, type ParsedRule, type RuleSets } from "../rules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0];
const platform = process.platform;
const fwd = (p: string): string => p.replace(/\\/g, "/");
const base = fs.realpathSync(mkTestTmp("pf-instroot-"));
const wt = path.join(base, "pkg.worktrees", "r1");
const inst = path.join(base, "lib", "pi-coding-agent");
const pkg = path.join(base, "pkg");
const gnpm = path.join(base, "lib", "node_modules");
const bundled = path.join(base, "bundles", "pi-subagents");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [path.join(wt, "src"), path.join(inst, "dist"), path.join(pkg, "extensions"), gnpm, bundled, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
const I = fwd(inst);
const P = fwd(pkg);
const W = fwd(wt);

const roots = (o: { child?: boolean; worktree?: string } = {}): GateRoots => ({
  worktree: o.worktree ?? wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [inst, gnpm, bundled], roundFlow: [], handoffs: [],
  child: o.child ?? false, role: o.child ? "builder" : "foreman", tmpAccess: false, pkgRoot: pkg,
});
const verdictOf = (r: GateResult): string => (r === undefined ? "none" : "block" in r ? `block:${r.rule}` : "allow" in r ? `allow:${r.rule}` : `ask:${r.rule}`);
function gate(tool: string, input: Record<string, unknown>, o: { child?: boolean; worktree?: string; sets?: RuleSets } = {}): string {
  const r = roots(o);
  return verdictOf(
    gateEvaluate(tool, input, o.worktree ?? wt, {
      env: (c) => baseFloorEnv(c, { ...(o.child ? { child: true } : {}), pkgRoot: pkg }),
      roots: () => r,
      ...(o.sets ? { rules: { sets: o.sets, env: { cwd: wt, home: base, platform, checkout: wt } } } : {}),
    }).result,
  );
}
const sh = (command: string, o?: { child?: boolean; worktree?: string; sets?: RuleSets }): string => gate("bash", { command }, o);
const IR = "ask:install-root-write";
const rl = (t: string): ParsedRule => {
  const r = parseRule(t);
  assert.ok(r.ok, t);
  return (r as { ok: true; rule: ParsedRule }).rule;
};

const ASKED = [
  `echo x > ${I}/dist/a.js`, `echo x >> ${I}/a`, `touch ${I}/a`, `rm ${I}/dist/a.js`, `rm -rf ${I}`, `cp a ${I}/a`, `mv a ${I}/a`, `mv ${I}/a b`, `sed -i s/a/b/ ${I}/a`,
  `cat a | tee ${I}/a`, `cd ${I} && touch f`, `mkdir ${I}/d`, `echo x > ${P}/extensions/a.ts`, `rm ${P}/extensions/a.ts`, `cp a ${P}/a`,
];
const UNASKED = [
  `cat ${I}/dist/a.js`, `ls ${I}`, `grep x ${I}/a`, `cp ${I}/a ${W}/a`, `cp ${P}/a ${W}/a`, `echo x > ${W}/a`, `echo x > ${W}/src/a.ts`, `touch ${W}/src/b`, `node ${I}/dist/cli.js`,
  `git -C ${I} status`, `git -C ${P} log`, `cd ${I} && git diff`, `cd ${I} && ls`, `cat a > /dev/null`, `echo x > ${fwd(scr)}/a`, "git status", "npm test",
];

test("main: a shell write into an install or package root is install-root-write", () => {
  for (const l of ASKED) assert.equal(sh(l), IR, l);
});

// a run that changes "somewhere under" a root asks, whatever the program: the catch-all target counts here (step 3), into each of the four roots
const ROOTS = [inst, gnpm, bundled, pkg].map(fwd);
const CATCH_ALL = (r: string): string[] => [
  `cd ${r} && make`, `cd ${r} && npm test`, `git -C ${r} pull`, `git -C ${r} fetch`, `npm --prefix ${r} test`, `npm --prefix ${r} install x`, `rsync -a x/ ${r}/x`,
  `perl -pi -e s/a/b/ ${r}/f`, `echo x > ${r}/f`, `cp a ${r}/f`, `rm ${r}/f`, `cat a | tee ${r}/f`, `sed -i s/a/b/ ${r}/f`, `cd ${r} && npm run test:node`, `make -C ${r} test`, `cd ${r} && git pull`,
];
const NOT_HIT = (r: string): string[] => [`cd ${r} && git fetch origin`, `cd ${r} && git status`, `cd ${r} && ls`, `git -C ${r} status`, `git -C ${r} log`, `cat ${r}/f`];

test("main: every program's catch-all target into any of the four roots asks; a read, a plain fetch and a status do not", () => {
  for (const r of ROOTS) {
    for (const l of CATCH_ALL(r)) assert.equal(sh(l), IR, l);
    for (const l of NOT_HIT(r)) assert.notEqual(sh(l), IR, `${l} -> ${sh(l)}`);
  }
  // beside it: the same programs in the session's own worktree ask nothing
  for (const l of ["make", "npm test", "git pull", "git fetch", `npm --prefix ${W} test`, `git -C ${W} pull`, `cd ${W} && make`]) assert.notEqual(sh(l), IR, l);
});

test("main: reads, test runs, writes in its own worktree and its scratch dir are not install-root-write", () => {
  for (const l of UNASKED) assert.notEqual(sh(l), IR, `${l} -> ${sh(l)}`);
});

test("main: the path tools write, edit and foreman_move are asked for a root, read, ls, grep, find and foreman_copy out of it are not", () => {
  for (const [tool, input] of [["write", { path: `${I}/a`, content: "x" }], ["edit", { path: `${P}/extensions/a.ts`, edits: [] }], ["foreman_move", { src: `${W}/a`, dst: `${I}/b` }], ["foreman_move", { src: `${I}/a`, dst: `${W}/b` }], ["foreman_copy", { src: `${W}/a`, dst: `${I}/b` }]] as const)
    assert.equal(gate(tool, { ...input }), IR, tool);
  for (const [tool, input] of [["read", { path: `${I}/a` }], ["ls", { path: I }], ["grep", { pattern: "x", path: I }], ["find", { pattern: "*.js", path: I }], ["foreman_copy", { src: `${I}/a`, dst: `${W}/b` }], ["write", { path: `${W}/src/a.ts`, content: "x" }], ["edit", { path: `${W}/src/a.ts`, edits: [] }]] as const)
    assert.notEqual(gate(tool, { ...input }), IR, tool);
});

test("main: a write spelled with @, a .. segment or file:// into a root is asked too", () => {
  assert.equal(gate("write", { path: `@${I}/a`, content: "x" }), IR);
  assert.equal(gate("write", { path: `${I}/dist/../a`, content: "x" }), IR);
  assert.equal(gate("write", { path: `${W}/src/../../../lib/pi-coding-agent/a`, content: "x" }), IR);
  assert.notEqual(gate("write", { path: `${W}/src/../a`, content: "x" }), IR);
});

test("an allow rule, a built-in allow or a bare Write allow does not clear it; a deny rule still refuses first", () => {
  const abs = (p: string): string => `${platform === "win32" ? "//" : "/"}${slashForm(platform, p)}/**`;
  const allow: RuleSets = { allow: [rl(`Write(${abs(inst)})`), rl("Bash(*)")], ask: [], deny: [] };
  assert.equal(gate("write", { path: `${I}/a`, content: "x" }, { sets: allow }), IR);
  assert.equal(sh(`echo x > ${I}/a`, { sets: allow }), IR);
  // beside it: the same rules still allow what is not in a root
  assert.match(gate("write", { path: `${W}/src/a.ts`, content: "x" }, { sets: allow }), /^allow:/);
  const deny: RuleSets = { allow: [], ask: [], deny: [rl(`Write(${abs(inst)})`)] };
  assert.match(gate("write", { path: `${I}/a`, content: "x" }, { sets: deny }), /^block:rule /);
  assert.notEqual(gate("write", { path: `${W}/src/a.ts`, content: "x" }, { sets: deny }), IR);
});

test("a child's write into a root is refused as a write outside its worktree, not asked; a child's read of it is not", () => {
  for (const l of [`echo x > ${I}/a`, `rm ${I}/a`, `cp a ${P}/a`]) assert.equal(sh(l, { child: true }), "block:child-write-outside", l);
  assert.equal(gate("write", { path: `${I}/a`, content: "x" }, { child: true }), "block:child-write-outside");
  for (const l of [`cat ${I}/dist/a.js`, `ls ${I}`, `echo x > ${W}/a`]) assert.ok(!sh(l, { child: true }).startsWith("block:child-write-outside"), l);
});

test("dev checkout: a session whose worktree is the package root is not asked for its own files, and still for an install root", () => {
  assert.notEqual(sh(`echo x > ${P}/extensions/a.ts`, { worktree: pkg }), IR);
  assert.notEqual(gate("write", { path: `${P}/extensions/a.ts`, content: "x" }, { worktree: pkg }), IR);
  assert.equal(sh(`echo x > ${I}/a`, { worktree: pkg }), IR);
  // beside it: from another worktree the same package file is asked
  assert.equal(sh(`echo x > ${P}/extensions/a.ts`), IR);
});

test("a worktree that lies inside the package root: its own files are not asked, the package root outside the worktree is", () => {
  const inner = path.join(pkg, "wts", "r2");
  fs.mkdirSync(path.join(inner, "src"), { recursive: true });
  assert.notEqual(sh(`echo x > ${fwd(inner)}/src/a.ts`, { worktree: inner }), IR);
  assert.notEqual(gate("write", { path: `${fwd(inner)}/src/a.ts`, content: "x" }, { worktree: inner }), IR);
  assert.equal(sh(`echo x > ${P}/extensions/a.ts`, { worktree: inner }), IR);
  assert.equal(gate("write", { path: `${P}/extensions/a.ts`, content: "x" }, { worktree: inner }), IR);
});

test("open, verdict of today: a change that names no path is not install-root-write", () => {
  // `npm install -g` names no folder: it stays the install danger class (a judge or the owner decides it); a write after `cd "$X"` has no target the gate can read
  for (const l of ["npm install -g left-pad", 'cd "$X" && touch f', "pip install requests"]) assert.notEqual(sh(l), IR, l);
});

// --- the full rig: the owner dialog, mode deny, no pane ------------------------------------------------------------------------------------------------------

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: {} } } };
async function rig(t: T, o: { mode?: string; headless?: boolean; answers?: string[] } = {}) {
  const titles: string[] = [];
  const answers = [...(o.answers ?? [])];
  const ui = { notify: () => undefined, confirm: async () => false, select: async (title: string) => (titles.push(title), answers.shift()), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const c = await r11Rig(t, {}, { ctx: { ui, ...(o.headless ? { hasUI: false, mode: "print" } : {}), ...(o.mode ? { [RIG_PERMISSIONS]: { mode: o.mode, allow: ["Write", "Edit", "Bash(*)"] } } : {}) }, config });
  return { ...c, titles };
}
const target = (): string => path.join(PKG, "extensions", "core-adapter", "no-such-file.ts");

test("owner: a write to the harness checkout from another worktree asks with the install-root-write cause, allow once goes on, a no is a deny", async (t) => {
  const yes = await rig(t, { answers: ["allow once"] });
  const res = await yes.call("write", { path: target(), content: "x" });
  assert.equal(yes.titles.length >= 1, true);
  assert.match(yes.titles[0], /install-root-write/);
  assert.match(yes.titles[0], /the pi-foreman package folder/);
  assert.ok(!res || !/install-root-write/.test(String(res.reason)), "allow once passes this step");
  const no = await rig(t, { answers: ["deny with comment"] });
  assert.ok((await no.call("write", { path: target(), content: "x" }))?.block);
  // beside it: a write in the session's own project asks nothing
  const own = await rig(t);
  assert.equal(await own.call("write", { path: path.join(own.project, ".workflow", "scratch", "a.txt"), content: "x" }), undefined);
  assert.equal(own.titles.length, 0);
});

test("mode deny refuses it without a dialog, mode allow and auto still ask; headless refuses", async (t) => {
  const deny = await rig(t, { mode: "deny" });
  const res = await deny.call("write", { path: target(), content: "x" });
  assert.ok(res?.block);
  assert.match(String(res.reason), /permissions mode is deny/);
  assert.equal(deny.titles.length, 0);
  for (const mode of ["allow", "auto"]) {
    const r = await rig(t, { mode, answers: ["deny with comment"] });
    assert.ok((await r.call("write", { path: target(), content: "x" }))?.block, mode);
    assert.match(r.titles[0] ?? "", /install-root-write/, mode);
  }
  const head = await rig(t, { headless: true });
  assert.ok((await head.call("write", { path: target(), content: "x" }))?.block);
  assert.equal(head.titles.length, 0);
});

test("a shell line that changes the harness checkout asks the owner in every mode, with an allow-everything classifier that is never called", async (t) => {
  let calls = 0;
  const verdict = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => (calls++, { content: [{ type: "text", text: verdict }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  for (const mode of ["auto", "allow", "ask"]) {
    for (const command of [`git -C ${fwd(PKG)} pull`, `cd ${fwd(PKG)} && make`]) {
      const titles: string[] = [];
      const ui = { notify: () => undefined, confirm: async () => false, select: async (title: string) => (titles.push(title), "deny with comment"), input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
      const c = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry, [RIG_PERMISSIONS]: { mode, allow: ["Write", "Edit", "Bash(*)"], classifier: { allow: ["Anything at all."] } } }, config });
      assert.ok((await c.call("bash", { command }))?.block, `${mode} ${command}`);
      assert.match(titles[0] ?? "", /install-root-write/, `${mode} ${command}`);
    }
  }
  assert.equal(calls, 0);
});

// list-mode `git branch` is no write for a read-only role (the read-only fence skips its catch-all), but install-root-write still counts it, as at head
test("git branch in list mode inside an install root still asks", () => {
  for (const l of [`git -C ${I} branch --contains HEAD`, `git -C ${I} branch --merged`, `cd ${I} && git branch -l`]) assert.equal(sh(l), IR, l);
});
