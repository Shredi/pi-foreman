// Defects round 1126: refusal texts name only bound folders (item 2), `mkdir -m 700` reads no mode as a path (5), /dev/null and the screen
// devices are no write target of cp (6), a foreman_copy source is only read (8), publish text on an unparsed line goes to the judge (14).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate, unreadableWriteText } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { bashCandidates } from "../manifest.ts";
import { opaqueTextFloors } from "../floors.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-d1126-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "wt", ".workflow", "scratch", "t1");
const out = path.join(base, "out");
const elsewhere = path.join(base, "elsewhere");
for (const d of [wt, scratch, out, elsewhere]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Role = "builder" | "reviewer" | "explorer";
type Bound = "both" | "scratch" | "none";
const rootsOf = (role: Role, bound: Bound = "both"): GateRoots => ({
  worktree: wt,
  scratch: bound === "both" ? [scratch, out] : bound === "scratch" ? [scratch] : [],
  ...(bound === "both" ? { out } : {}),
  tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false,
  ...(role !== "builder" ? { roundReadOnly: true } : {}),
  ...(role === "builder" ? { builder: true } : {}),
});
type Out = { result?: { block?: boolean; rule?: string; reason?: string }; dangers?: string[]; danger?: { name: string } };
const run = (tool: string, input: unknown, role: Role = "builder", bound: Bound = "both"): Out => {
  const roots = rootsOf(role, bound);
  return gateEvaluate(tool, input, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: roots.scratch, ...(roots.out ? { out: roots.out } : {}) }), roots: () => roots }) as Out;
};
const shell = (command: string, role: Role = "builder", bound: Bound = "both") => run("bash", { command }, role, bound);
const blocked = (command: string, role: Role = "builder"): boolean => !!shell(command, role).result?.block;
const labels = (command: string, role: Role = "builder"): string[] => shell(command, role).dangers ?? [];

// item 2: the refusal names only folders the child has
test("child-write-outside names $FOREMAN_SCRATCH only with a scratch dir", { skip: posixOnly }, () => {
  const cmd = `cp a ${elsewhere}/b`;
  for (const [bound, scr] of [["both", true], ["scratch", true], ["none", false]] as const) {
    const r = shell(cmd, "builder", bound).result;
    assert.equal(r?.rule, "child-write-outside", bound);
    assert.equal(/\$FOREMAN_SCRATCH/.test(r?.reason ?? ""), scr, `${bound}: ${r?.reason}`);
    assert.ok(!/\$FOREMAN_OUT/.test(r?.reason ?? ""), bound);
  }
});

test("child-write-outside names $FOREMAN_SCRATCH in the /tmp hint only with a scratch dir", { skip: posixOnly }, () => {
  const withScratch = shell("cp a /tmp/pf-x/b", "builder", "both").result?.reason ?? "";
  assert.match(withScratch, /Use \$FOREMAN_SCRATCH/);
  const none = shell("cp a /tmp/pf-x/b", "builder", "none").result?.reason ?? "";
  assert.ok(!/\$FOREMAN_SCRATCH/.test(none), none);
  assert.match(none, /No scratch dir is bound/);
});

test("child-reviewer-write names $FOREMAN_OUT only with an output dir and no variable when none is bound", { skip: posixOnly }, () => {
  // a reviewer outside a round (no roundReadOnly) reaches the reviewer's own write rule
  const w = (bound: Bound) => {
    const roots = { ...rootsOf("reviewer", bound), roundReadOnly: false };
    return (gateEvaluate("write", { path: path.join(wt, "f.txt"), content: "x" }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: roots.scratch, ...(roots.out ? { out: roots.out } : {}) }), roots: () => roots }) as Out).result;
  };
  assert.equal(w("both")?.rule, "child-reviewer-write");
  assert.ok(w("both")?.reason?.includes(out), "bound text keeps the paths");
  const scratchOnly = w("scratch")?.reason ?? "";
  assert.ok(!/\$FOREMAN_OUT/.test(scratchOnly) && scratchOnly.includes(scratch), scratchOnly);
  const none = w("none")?.reason ?? "";
  assert.ok(!/\$FOREMAN_(OUT|SCRATCH)/.test(none), none);
  assert.match(none, /nowhere/);
});

test("child-write-foreman-checkout names $FOREMAN_SCRATCH only with a scratch dir", () => {
  // the command line is shell text: forward slashes, a backslash would be eaten
  const elsewhereSh = elsewhere.replaceAll("\\", "/");
  const roots = { ...rootsOf("builder", "none"), checkout: elsewhere };
  const r = gateEvaluate("bash", { command: `cp a ${elsewhereSh}/b` }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: () => roots }).result as { reason?: string; rule?: string } | undefined;
  assert.equal(r?.rule, "child-write-foreman-checkout");
  assert.ok(!/\$FOREMAN_SCRATCH/.test(r?.reason ?? ""), r?.reason);
  const roots2 = { ...rootsOf("builder", "both"), checkout: elsewhere };
  const r2 = gateEvaluate("bash", { command: `cp a ${elsewhereSh}/b` }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: roots2.scratch, out }), roots: () => roots2 }).result as { reason?: string } | undefined;
  assert.match(r2?.reason ?? "", /\$FOREMAN_SCRATCH/);
});

test("unreadableWriteText names only the bound folders", () => {
  const both = unreadableWriteText("no", true, rootsOf("builder", "both"));
  assert.match(both, /`\$FOREMAN_SCRATCH`, `\$FOREMAN_OUT` or your worktree/);
  const scratchOnly = unreadableWriteText("no", true, rootsOf("builder", "scratch"));
  assert.ok(!/FOREMAN_OUT/.test(scratchOnly) && /FOREMAN_SCRATCH/.test(scratchOnly), scratchOnly);
  const worktreeOnly = unreadableWriteText("no", true, rootsOf("builder", "none"));
  assert.ok(!/FOREMAN_/.test(worktreeOnly) && /your worktree/.test(worktreeOnly), worktreeOnly);
  const nothing = unreadableWriteText("no", false, rootsOf("reviewer", "none"));
  assert.ok(!/FOREMAN_|your worktree/.test(nothing), nothing);
  assert.match(nothing, /No writable folder outside the worktree is bound/);
});

test("a redirect to $FOREMAN_OUT or $FOREMAN_SCRATCH is the session's own target when bound", { skip: posixOnly }, () => {
  for (const c of [`make > "$FOREMAN_OUT/build.log" 2>&1`, `make > "$FOREMAN_SCRATCH/build.log"`, `make 2> $FOREMAN_OUT/e.log`]) {
    assert.equal(blocked(c), false, c);
    assert.ok(!labels(c).includes("danger-write-outside"), c);
  }
});

// item 5: `mkdir -m 700` takes its mode as a value
test("mkdir with a mode option: the mode is no target; a target outside is still flagged", { skip: posixOnly }, () => {
  const inside = `${scratch}/x`;
  for (const c of [`mkdir -m 700 ${inside}`, `mkdir -pm 700 ${inside}`, `mkdir --mode 700 ${inside}`, `mkdir --mode=700 ${inside}`, `mkdir -m700 ${inside}`, `mkdir -p -m 755 ${inside}`]) {
    assert.equal(blocked(c, "builder"), false, c);
    assert.equal(blocked(c, "reviewer"), false, c);
    assert.equal(blocked(c, "explorer"), false, c);
  }
  for (const c of [`mkdir -m 700 ${elsewhere}/x`, `mkdir -pm 700 ${elsewhere}/x`, `mkdir --mode 700 ${elsewhere}/x`]) assert.equal(blocked(c, "builder"), true, c);
});

test("manifest: mkdir with a mode option records only the scratch dir", { skip: posixOnly }, () => {
  const ctx = { cwd: wt, stateDir: path.join(base, "state"), platform: "linux" };
  const target = `${wt}/.workflow/scratch/topic-a`;
  for (const c of [`mkdir -m 700 ${target}`, `mkdir -pm 700 ${target}`, `mkdir --mode 700 ${target}`, `mkdir --mode=700 ${target}`, `mkdir -m700 ${target}`]) {
    assert.deepEqual(bashCandidates(c, ctx), [{ kind: "scratch", path: target }], c);
  }
});

// item 6: the discard device and the screen outputs are no write target
test("cp to /dev/null, /dev/stdout and /dev/stderr is no write outside; another device still is", { skip: posixOnly }, () => {
  for (const role of ["builder", "reviewer", "explorer"] as const) {
    for (const c of ["cp a b /dev/null", "cp x /dev/stdout", "cp x /dev/stderr"]) {
      assert.equal(blocked(c, role), false, `${role}: ${c}`);
      assert.ok(!labels(c, role).includes("danger-write-outside"), `${role}: ${c}`);
    }
  }
  assert.equal(blocked("cp a /dev/sda", "builder"), true);
});

// item 8: a foreman_copy source is only read
test("foreman_copy: the destination is checked against the write area, the source only for readability", () => {
  fs.writeFileSync(path.join(out, "f"), "x");
  const copy = (src: string, dst: string, role: Role = "builder") => run("foreman_copy", { src, dst }, role);
  const verdict = (o: ReturnType<typeof run>): boolean => !!o.result?.block || !!o.danger;
  assert.equal(verdict(copy(path.join(out, "f"), path.join(wt, "f"))), false, "out -> worktree");
  assert.equal(verdict(copy("/tmp/pf-src-f", path.join(wt, "f"))), false, "a source under /tmp");
  assert.equal(verdict(copy(path.join(out, "f"), path.join(elsewhere, "f"))), true, "a destination outside");
  const key = copy(path.join(process.env.HOME ?? "/root", ".ssh", "id_rsa"), path.join(wt, "k"));
  assert.equal(verdict(key), true, "a secret source");
});

// item 14: publish text on an unparsed line is judge-first
const fenv = baseFloorEnv(wt, { child: false });
test("opaque line: a publish text hit is judge-first, not a deny; a hard floor after it still wins", () => {
  const hit = opaqueTextFloors("echo 'it''s' ; cat <<'E'\nnpm publish\nE\n", fenv);
  assert.equal(hit?.kind, "judge");
  assert.equal(hit?.rule, "danger-publish");
  const rm = opaqueTextFloors("npm publish; rm -rf /", fenv);
  assert.equal(rm?.kind, "deny");
  assert.equal(rm?.rule, "floor-rm-system");
  const cfg = opaqueTextFloors("git config remote.origin.url x; npm publish", fenv);
  assert.equal(cfg?.rule, "danger-git-config");
});

test("the heredoc body with npm publish plus an unbalanced quote elsewhere goes to the judge", { skip: posixOnly }, () => {
  const line = `cat > f <<'E'\nnpm publish\nE\necho "unbalanced`;
  const o = run("bash", { command: line }, "builder");
  assert.ok(!o.result?.block, JSON.stringify(o.result));
  assert.equal(o.danger?.name, "danger-publish");
});

test("parsed publish commands keep their hard floor; code handed to a runner too; write-tool content is no command", { skip: posixOnly }, () => {
  for (const c of ["npm publish", "cargo publish", "gh release create v1", `node -e "require('child_process').exec('npm publish')"`]) {
    const r = shell(c, "builder").result;
    assert.ok(r?.block || shell(c, "builder").danger, c);
    if (!c.startsWith("node")) assert.match(r?.rule ?? "", /^(floor-|child-)/, c);
  }
  const node = shell(`node -e "require('child_process').exec('npm publish')"`, "builder");
  assert.ok(node.result?.block || node.danger, "node -e");
  assert.ok(!run("write", { path: path.join(wt, "notes.md"), content: "run npm publish later\n" }, "builder").result?.block);
});
