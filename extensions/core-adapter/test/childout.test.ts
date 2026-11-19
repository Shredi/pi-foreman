// D26: each child launch gets a kept output dir ($FOREMAN_OUT, `<agentDir>/pi-foreman/child-out/<session>/<launch>`): a second scratch-like write
// root the harness does not remove at run end; the foreman reads it after the run; the next session start sweeps launch folders older than 7 days.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { ChildScratch, expandOutVar, finishScratch, launchScratch, sweepKept } from "../childscratch.ts";
import type { ScratchHost } from "../childscratch.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { LaunchBinding } from "../usage.ts";
import { posix, posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-childout-"));
const tmp = path.join(base, "tmp");
const agentDir = path.join(base, "agent");
const wt = path.join(base, "wt");
for (const d of [tmp, agentDir, wt]) fs.mkdirSync(d);
const deps = { tmpdir: () => tmp };
after(() => fs.rmSync(base, { recursive: true, force: true }));

const host = (): ScratchHost => ({ id: "sess-1", cwd: wt, config: { config: {} }, scratch: new ChildScratch(), agentDir });
const binding = (launchId: string): LaunchBinding => ({ foremanSession: "sess-1", workspace: wt, role: "builder", launchId, kind: "first", model: null });

const h = host();
const b = binding("L-1");
const input: Record<string, unknown> = { agent: "builder", task: "go" };
launchScratch(h, input, b, deps);
const out = b.out!;

test("launch: the kept dir is under <agentDir>/pi-foreman/child-out, in the binding and the task", () => {
  assert.equal(out, path.join(agentDir, "pi-foreman", "child-out", "sess-1", "L-1"));
  assert.ok(fs.statSync(out).isDirectory());
  if (posix) assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  assert.match(String(input.task), new RegExp(`FOREMAN_OUT.*7 days|${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a log written by the child is still there after the run ended, the scratch dir is gone", () => {
  fs.writeFileSync(path.join(out, "log.txt"), "npm test: ok\n");
  assert.equal(h.scratch.onLaunched("L-1", "run-1"), null);
  finishScratch(h, h.scratch.onRunEnd("run-1"), deps);
  assert.equal(fs.existsSync(b.scratch!), false);
  assert.equal(fs.readFileSync(path.join(out, "log.txt"), "utf8"), "npm test: ok\n");
});

const roots = (child: boolean): GateRoots => ({
  worktree: wt,
  scratch: child ? [b.scratch!, out] : [],
  ...(child ? { out } : {}),
  tmp: [tmp],
  scratchBase: path.join(tmp, "pi-foreman-scratch"),
  owned: child ? [] : [path.join(agentDir, "pi-foreman")],
  install: [],
  roundFlow: [],
  handoffs: [],
  child,
  role: child ? "builder" : "foreman",
  tmpAccess: true,
  agentDir,
});
const decide = (tool: string, inp: Record<string, unknown>, child = true) => gateEvaluate(tool, inp, wt, { env: (cwd) => baseFloorEnv(cwd, { child, agentDir, scratch: child ? [b.scratch!, out] : [] }), roots: () => roots(child) });
/** The gate finds nothing to refuse or ask: an allow verdict, or no verdict and no danger class. */
const allowed = (tool: string, inp: Record<string, unknown>): boolean => {
  const o = decide(tool, inp);
  const r = o.result as { allow?: boolean } | undefined;
  return r ? r.allow === true : o.danger === null;
};
const refused = (tool: string, inp: Record<string, unknown>): boolean => !!(decide(tool, inp).result as { block?: boolean } | undefined)?.block;

test("a child's bash redirect and rm below $FOREMAN_OUT are allowed; a sibling outside the worktree is refused", { skip: posixOnly }, () => {
  for (const command of ['npm test > "$FOREMAN_OUT/log.txt" 2>&1', "npm test > ${FOREMAN_OUT}/log.txt", 'rm -rf "$FOREMAN_OUT/sub"']) assert.equal(allowed("bash", { command }), true, command);
  assert.equal(refused("bash", { command: `npm test > ${path.join(base, "sibling", "log.txt")}` }), true);
  assert.equal(refused("bash", { command: 'npm test > "$FOREMAN_OUT/../log.txt"' }), true);
});

test("the write tool to the kept dir is allowed, to a sibling it is refused", () => {
  assert.equal(allowed("write", { path: path.join(out, "x.log"), content: "x" }), true);
  assert.equal(refused("write", { path: path.join(agentDir, "pi-foreman", "child-out", "sess-1", "other", "x.log"), content: "x" }), true);
  assert.equal(refused("write", { path: path.join(base, "sibling", "x.log"), content: "x" }), true);
});

test("a line that rebinds FOREMAN_OUT is not read as the kept dir", { skip: posixOnly }, () => {
  for (const command of ["FOREMAN_OUT=/etc; echo x > $FOREMAN_OUT/f", "export FOREMAN_OUT=/etc && echo x > $FOREMAN_OUT/f", "env FOREMAN_OUT=/etc sh -c 'echo x > $FOREMAN_OUT/f'"]) {
    assert.equal(allowed("bash", { command }), false, command);
  }
});

test("the foreman reads the kept log through the gate after the run", () => {
  const r = decide("read", { path: path.join(out, "log.txt") }, false).result as { block?: boolean; ask?: boolean } | undefined;
  assert.ok(r === undefined || (!r.block && !r.ask), JSON.stringify(r));
});

test("expandOutVar reads only plain references", () => {
  // win32 accepts only a drive path (shellSafeDir), so the fixture dir is platform-correct
  const o = posix ? "/o" : "C:/o";
  assert.equal(expandOutVar('cat > "$FOREMAN_OUT/a" && ls ${FOREMAN_OUT}', o), `cat > "${o}/a" && ls ${o}`);
  for (const c of ["FOREMAN_OUT=/x; ls $FOREMAN_OUT", "ls '$FOREMAN_OUT'", "ls \\$FOREMAN_OUT", "ls ${FOREMAN_OUT:-x}", "ls $FOREMAN_OUTX"]) {
    assert.equal(expandOutVar(c, o), c, c);
  }
  assert.equal(expandOutVar("ls $FOREMAN_OUT", `${o} p`), "ls $FOREMAN_OUT", "a dir with a shell character is never put in");
});

test("an apostrophe in a heredoc body or a comment never lets a quoted $FOREMAN_OUT through", { skip: posixOnly }, () => {
  const outside = path.join(base, "elsewhere");
  for (const command of [
    `cat <<EOF > /dev/null\nit's\nEOF\ncd ${outside} && echo x > '$FOREMAN_OUT/y'`,
    `# it's a comment\ncd ${outside} && echo x > '$FOREMAN_OUT/y'`,
  ]) {
    assert.equal(expandOutVar(command, "/o"), command, command);
    assert.equal(allowed("bash", { command }), false, command);
  }
  assert.equal(expandOutVar('cat > "$FOREMAN_OUT/a" <<EOF\nplain\nEOF', "/o"), 'cat > "/o/a" <<EOF\nplain\nEOF', "a heredoc without an apostrophe still resolves");
});

test("an apostrophe anywhere leaves $FOREMAN_OUT unresolved: nested-quote bypasses are refused", { skip: posixOnly }, () => {
  const outside = path.join(base, "elsewhere2");
  for (const command of [
    `cd ${outside} && case "$(mkdir -p '$FOREMAN_OUT' && touch '$FOREMAN_OUT/y')" in *) ;; esac`,
    `cd ${outside} && case "\`touch '$FOREMAN_OUT/y'\`" in *) ;; esac`,
    `cd ${outside} && case "\${u:-"'"}" in *) ;; esac; touch '$FOREMAN_OUT'; case "\${u:-"'"}" in *) ;; esac`,
  ]) {
    assert.equal(expandOutVar(command, "/o"), command, command);
    assert.equal(allowed("bash", { command }), false, command);
  }
});

// ----------------------------------------------------------------------------------------------------------------- the sweep
const DAY = 86400000;
const root = path.join(agentDir, "pi-foreman", "child-out");
const age = (p: string, days: number): void => {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
};

test("the sweep removes launch folders older than 7 days (any session), keeps newer ones, drops emptied session folders", () => {
  const old = path.join(root, "sess-old", "L-old");
  const young = path.join(root, "sess-old", "L-young");
  const oldAlone = path.join(root, "sess-alone", "L-x");
  for (const d of [old, young, oldAlone]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(old, "log.txt"), "x");
  age(old, 8);
  age(oldAlone, 30);
  age(young, 6);
  assert.equal(sweepKept(agentDir), 2);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(path.join(root, "sess-alone")), false, "an emptied session folder goes");
  assert.equal(fs.existsSync(path.join(root, "sess-old")), true);
  assert.equal(fs.existsSync(out), true, "this run's folder is new");
});

test("the sweep never follows a link: one inside an old folder goes as a link, one at the launch level stays", { skip: posixOnly }, () => {
  const target = path.join(base, "precious");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "k");
  const old = path.join(root, "sess-link", "L-old");
  fs.mkdirSync(old, { recursive: true });
  fs.symlinkSync(target, path.join(old, "lnk"));
  fs.symlinkSync(target, path.join(root, "sess-link", "L-link"));
  age(old, 9);
  assert.equal(sweepKept(agentDir), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "k");
  assert.equal(fs.lstatSync(path.join(root, "sess-link", "L-link")).isSymbolicLink(), true, "a link at the launch level is not a launch folder");
  // a linked session folder is not entered
  fs.symlinkSync(target, path.join(root, "sess-via-link"));
  fs.mkdirSync(path.join(target, "L-old"));
  age(path.join(target, "L-old"), 40);
  sweepKept(agentDir);
  assert.equal(fs.existsSync(path.join(target, "L-old")), true);
});

test("the sweep does nothing without a child-out folder", () => {
  assert.equal(sweepKept(path.join(base, "no-agent")), 0);
});
