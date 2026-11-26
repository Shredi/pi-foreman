// Ledger item 17: a child's write that only creates a sanctioned root itself (`mkdir -p <scratch root>`, `mkdir <scratch root>`) is inside, for a builder and a
// round reviewer. Everything else on the root (delete, move, link over, chmod, chown, touch, a redirect) stays refused; so do the parent of the scratch root, another
// session's scratch dir and (for a reviewer) a write into the worktree. The main session's verdicts are pinned unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posix, posixOnly } from "./_platform.ts";

process.env.PI_OFFLINE = "1";

const base = fs.realpathSync(mkTestTmp("pf-rm-"));
const wt = path.join(base, "wt");
const scratchBase = path.join(base, "tmp", "pi-foreman-scratch");
const scr = path.join(scratchBase, "mine");
const otherScr = path.join(scratchBase, "other");
for (const d of [path.join(wt, "sub"), scratchBase]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
// the scratch root itself does not exist yet (the case that matters: `mkdir -p` creates it)

type Verdict = { block?: boolean; ask?: boolean; rule?: string; reason?: string } | undefined;
const roots = (who: "builder" | "reviewer" | "main"): GateRoots => ({
  worktree: wt, scratch: [scr], tmp: [], scratchBase, owned: [], install: [], roundFlow: [], handoffs: [], ...(who === "main" ? {} : { childHandoff: path.join(base, "handoffs", "h1") }),
  child: who !== "main", role: who === "main" ? "foreman" : who, tmpAccess: false, ...(who === "reviewer" ? { roundReadOnly: true } : {}),
});
const verdict = (command: string, who: "builder" | "reviewer" | "main", cwd = wt): Verdict =>
  gateEvaluate("bash", { command }, cwd, { env: (c) => baseFloorEnv(c, who === "main" ? { scratch: [scr] } : { child: true, scratch: [scr] }), roots: () => roots(who) }).result as Verdict;
const what = (v: Verdict): string => (v?.block ? `block:${v.rule}` : v?.ask ? `ask:${v.rule}` : v ? `allow:${(v as { rule?: string }).rule}` : "none");
const CHILDREN = ["builder", "reviewer"] as const;
const OK = ["allow:default-write-in"];

// the literal path in the `/var` spelling of the same dir (darwin: /private/var -> /var); null where the rig has no such alias
const alias = posix && base.startsWith("/private/var/") ? base.slice("/private".length) : null;

const FORMS: [string, string][] = [
  ["mkdir -p $FOREMAN_SCRATCH", "-p, bare variable"],
  ["mkdir $FOREMAN_SCRATCH", "plain mkdir"],
  ['mkdir -p "$FOREMAN_SCRATCH"', "-p, quoted variable"],
  ["mkdir -p ${FOREMAN_SCRATCH}", "-p, braced variable"],
  ["S=$FOREMAN_SCRATCH; mkdir -p $S", "-p, assigned variable"],
  [`mkdir -p ${scr}`, "-p, literal path"],
  [`mkdir ${scr}`, "plain mkdir, literal path"],
  [`mkdir -p ${scr}/`, "-p, literal path with a slash"],
  [`mkdir -pv ${scr}`, "-pv"],
  [`mkdir -p -- ${scr}`, "-p --"],
  [`mkdir -p ${scr} ${scr}/sub`, "root and a child of it"],
  ...(alias ? ([[`mkdir -p ${alias}/tmp/pi-foreman-scratch/mine`, "-p, /var spelling"], [`mkdir ${alias}/tmp/pi-foreman-scratch/mine`, "plain mkdir, /var spelling"]] as [string, string][]) : []),
];

for (const who of CHILDREN) {
  test(`${who}: mkdir that only creates the scratch root is not refused`, { skip: posixOnly }, () => {
    for (const [l, why] of FORMS) assert.deepEqual([what(verdict(l, who))], l.startsWith("S=") ? ["allow:default-assign+default-write-in"] : OK, `${why}: ${l}`);
  });

  test(`${who}: the scratch root is the sanctioned target, its child was already free`, { skip: posixOnly }, () => {
    assert.deepEqual([what(verdict(`mkdir -p ${scr}/sub`, who))], OK);
    assert.deepEqual([what(verdict(`mkdir -p $FOREMAN_SCRATCH/sub`, who))], OK);
  });

  test(`${who}: shape E (mkdir the root, cd into it, write a script by heredoc, run it) is not refused as a write outside`, { skip: posixOnly }, () => {
    const line = "mkdir -p $FOREMAN_SCRATCH && cd $FOREMAN_SCRATCH && cat > p.py <<EOF\nprint(1)\nEOF\npython3 -I p.py";
    const v = verdict(line, who);
    assert.notEqual(v?.rule, "child-write-outside", what(v));
    // no decision for either role (the reviewer's script run carries no label): the call falls through to the mode step
    assert.equal(what(v), "none", line);
  });

  test(`${who}: every other write on the scratch root stays refused`, { skip: posixOnly }, () => {
    const rows: [string, string][] = [
      [`rm -rf ${scr}`, "child-write-outside"], [`rm -rf $FOREMAN_SCRATCH`, "child-write-outside"], [`mv x ${scr}`, "child-write-outside"],
      [`mv ${scr} ${path.join(base, "gone")}`, "child-write-outside"], [`touch ${scr}`, "child-write-outside"], [`echo x > ${scr}`, "child-write-outside"], [`cp a ${scr}`, "child-write-outside"],
      [`mkdir -p ${scr} && rm -rf ${scr}`, "child-write-outside"], [`mkdir -p ${scr} ${path.dirname(scr)}`, "child-write-outside"],
    ];
    for (const [l, rule] of rows) {
      const v = verdict(l, who);
      assert.equal(what(v), `block:${rule}`, l);
    }
  });

  // these programs are no write verb of the effect classifier: the verdict on the root is the one of today (no decision, the same as for a path below the root), pinned so a change shows
  test(`${who}: rmdir, chmod, chown, ln and mkdir -m on the scratch root keep today's verdict`, { skip: posixOnly }, () => {
    for (const l of [`rmdir ${scr}`, `chmod 777 ${scr}`, `chown u ${scr}`, `ln -sfn x ${scr}`, `mkdir -m 777 ${scr}`]) {
      assert.equal(what(verdict(l, who)), l.startsWith("mkdir -m") ? "allow:default-write-in" : "none", l); // D187: `-m 777` is mkdir's mode, no path, so mkdir of the scratch root is a write inside
      const below = l.replace(scr, `${scr}/sub`);
      assert.equal(what(verdict(below, who)), what(verdict(l, who)), below);
    }
  });

  test(`${who}: the parent of the scratch root and another session's scratch dir stay refused`, { skip: posixOnly }, () => {
    for (const l of [`mkdir -p ${scratchBase}`, `mkdir ${scratchBase}`, `mkdir -p ${otherScr}`, `mkdir -p ${otherScr}/sub`, `mkdir -p ${path.dirname(scratchBase)}`]) {
      assert.equal(what(verdict(l, who)), "block:child-write-outside", l);
    }
  });

  test(`${who}: the refusal names the refused operand of a mkdir, not only the worktree`, { skip: posixOnly }, () => {
    const v = verdict(`mkdir -p ${scr} ${otherScr}`, who);
    assert.match(v?.reason ?? "", new RegExp(`Refused: ${otherScr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
}

test("reviewer: mkdir -p of the worktree root and of anything below it is child-readonly-write", { skip: posixOnly }, () => {
  for (const l of [`mkdir -p ${wt}`, `mkdir ${wt}`, `mkdir -p ${wt}/sub`, `mkdir -p ${wt}/new`, "mkdir -p sub/new", "mkdir -p ."]) {
    assert.equal(what(verdict(l, "reviewer")), "block:child-readonly-write", l);
  }
});

test("builder: mkdir -p of the worktree root is as free as of a path below it", { skip: posixOnly }, () => {
  for (const l of [`mkdir -p ${wt}`, `mkdir -p ${wt}/sub`, `mkdir -p ${wt}/new`]) assert.deepEqual([what(verdict(l, "builder"))], OK, l);
});

test("main: the verdicts of mkdir -p on its roots are unchanged", { skip: posixOnly }, () => {
  const rows: [string, string][] = [
    [`mkdir -p ${scr}`, "none"], [`mkdir ${scr}`, "none"], [`mkdir -p ${scr}/sub`, "allow:default-write-in"], [`mkdir -p ${wt}`, "none"],
    [`mkdir -p ${wt}/sub`, "allow:default-write-in"], [`mkdir -p ${scratchBase}`, "none"], [`mkdir -p ${otherScr}`, "none"], [`rm -rf ${scr}`, "none"],
  ];
  for (const [l, want] of rows) assert.equal(what(verdict(l, "main")), want, l);
});

test("main with tmp access: mkdir -p /tmp is unchanged", { skip: posixOnly }, () => {
  const r = { ...roots("main"), tmpAccess: true, tmp: ["/tmp"] };
  const v = gateEvaluate("bash", { command: "mkdir -p /tmp" }, wt, { env: (c) => baseFloorEnv(c, {}), roots: () => r }).result as Verdict;
  assert.equal(what(v), "none");
});

test("builder: mkdir -p /tmp stays refused (a child has no tmp write root)", { skip: posixOnly }, () => {
  assert.equal(what(verdict("mkdir -p /tmp", "builder")), "block:child-write-outside");
});
