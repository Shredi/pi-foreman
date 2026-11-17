// Guard round 2: the own-ruling refusal (ruling.ts selfRulingRefusal) also refuses (a) a write target with an unquoted glob that can match a ruling or brief name in the
// session's own handoff dir (also a glob in a directory part), (b) a bare or relative ruling name written after a directory change the gate cannot resolve (a variable, a
// substitution, a directory that does not exist). Reads, copies from a ruling, globs that cannot match, other dirs, the parent session and a top-level session are no refusal.
// A write through a link onto the ruling is not refused (gap 3, pinned as it is). Lines are data strings, never run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { childHandoffDirs } from "../owned.ts";
import { readPlanVerdict } from "../checkpoint.ts";
import { SELF_RULING_REASON, SelfRulings, selfRulingRefusal, toolWriteRuling } from "../ruling.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r2glob-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const hand = path.join(root, ".workflow", "handoffs");
const H = path.join(hand, "up");
const wt = path.join(root, "wt");
fs.mkdirSync(H, { recursive: true });
fs.mkdirSync(path.join(wt, "src"), { recursive: true });
fs.writeFileSync(path.join(H, "parent"), "other\n");
fs.writeFileSync(path.join(H, "child"), "me\n");
fs.writeFileSync(path.join(H, "ruling.md"), "APPROVED\n");
const posix = process.platform !== "win32";
const GT = ">";

// the sub-session and the builder are children of the parent session (the dirs where they are the child); the parent and a top-level session have none
const childDirs = childHandoffDirs(hand, "me");
assert.deepEqual(childDirs, [H]);
const parentDirs = childHandoffDirs(hand, "other");
assert.deepEqual(parentDirs, []);
const refusal = (command: string, dirs: string[], cwd = root): string | undefined => selfRulingRefusal("bash", { command }, cwd, dirs);

const REFUSED = [
  `echo x ${GT} ${H}/ru*.md`,
  `echo x | tee ${H}/r?ling.md`,
  `cp a ${H}/*.md`,
  `cd ${H} && cp a ru*.md`,
  `sed -i s/a/b/ ${H}/ruling*.md`,
  `rm ${H}/[r]uling.md`,
  `echo x ${GT} ${H}/ruling-*.md`,
  `echo x ${GT} ${H}/brief-*.md`,
  `echo x ${GT} ${H}/*`,
  `echo x ${GT} ${hand}/*/ruling.md`,
  `cd ${hand} && echo x ${GT} */ruling.md`,
  `cd ${hand}/up && echo x ${GT} ruling*`,
  `cd $X && echo x ${GT} ruling.md`,
  'cd "$(dirname $F)" && tee ruling-2.md',
  `cd ${root}/not-yet && echo x ${GT} ruling.md`,
  "pushd $X; cp a ruling.md",
  `cd $X && echo x ${GT} brief-2.md`,
  `cd $X && rm ru*.md`,
  `echo x ${GT} $D/ru*.md`,
];

test("a sub-session and a builder: the glob and unresolved-cwd writes onto a ruling name are refused", () => {
  for (const line of REFUSED) assert.equal(refusal(line, childDirs), SELF_RULING_REASON, line);
});

const FREE = [
  `cat ${H}/ru*.md`,
  `cp ${H}/ruling.md .workflow/scratch/r.md`,
  `cp ${H}/ru*.md ${wt}/src`,
  `grep x ${H}/*.md`,
  `ls ${H}/*`,
  `echo x ${GT} ${H}/notes-*.md`,
  `rm ${H}/ask*.md`,
  `cp a ${H}/plan*.md`,
  `rm ${wt}/src/*.md`,
  `cd ${wt}/src && rm r*.md`,
  `cd ${wt}/src && echo x ${GT} ruling.md`,
  'echo "see ruling.md"',
  'git commit -m "ru*.md"',
  "cd $X && cat ruling.md",
  `cd $X && echo x ${GT} notes.md`,
  `echo x ${GT} ${wt}/src/*/ruling.md`,
];

test("a sub-session and a builder: reads, other names, other dirs and text mentions are no refusal", () => {
  for (const line of FREE) assert.equal(refusal(line, childDirs), undefined, line);
});

test("the parent session and a top-level session: none of the refusals fire", () => {
  for (const line of [...REFUSED, ...FREE, `echo x ${GT} ${H}/ruling.md`, `cp a ${H}/ruling*.md`]) assert.equal(refusal(line, parentDirs), undefined, line);
});

const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], openedHandoffs: [H], child: false, role: "foreman", tmpAccess: false };
function show(tool: string, input: Record<string, unknown>): string {
  const o = gateEvaluate(tool, input, wt, { env: (c) => baseFloorEnv(c, {}), roots: () => roots });
  const r = o.result as { block?: boolean; allow?: boolean; ask?: boolean; rule?: string } | undefined;
  return `${r ? (r.block ? "block" : r.allow ? "allow" : r.ask ? "ask" : "other") : "undecided"} ${r?.rule ?? ""} ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
}

test("the parent writes the child's ruling by redirect, cp and the write tool: the gate allows, the refusal stays silent", { skip: !posix }, () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["bash", { command: `echo x ${GT} ${H}/ruling.md` }, "allow default-write-handoff-ruling []"],
    ["bash", { command: `cp a ${H}/ruling.md` }, "allow default-write-handoff-ruling []"],
    ["write", { path: `${H}/ruling.md`, content: "x" }, "allow path-write-handoff-ruling []"],
  ];
  for (const [tool, input, want] of cases) {
    assert.equal(show(tool, input), want, JSON.stringify(input));
    assert.equal(selfRulingRefusal(tool, input, wt, parentDirs), undefined, JSON.stringify(input));
  }
});

test("the parent writes the child's ruling by a glob: no self-ruling refusal (the gate gives no allow)", { skip: !posix }, () => {
  const input = { command: `cp a ${H}/ruling*.md` };
  assert.equal(show("bash", input), 'undecided  ["danger-opaque"]');
  assert.equal(selfRulingRefusal("bash", input, wt, parentDirs), undefined);
});

// gap 3: the refusal compares the literal name of the target (real path of its directory only), so a write through a link named otherwise is not refused. The
// existing r11-ruling-no-effect test pins that outcome. The write is recorded as self-written by the tool_call result hook (toolWriteRuling, tests below), so it is ignored.
test("a write through a link onto the ruling is not refused (known, pinned as it is)", { skip: !posix }, () => {
  const dir = fs.mkdtempSync(path.join(root, "lnk-"));
  fs.symlinkSync(path.join(H, "ruling.md"), path.join(dir, "link"));
  for (const [tool, input] of [
    ["bash", { command: `echo x ${GT} link` }],
    ["bash", { command: "cp a link" }],
    ["write", { path: "link", content: "x" }],
    ["edit", { path: "link", edits: [] }],
  ] as const) {
    assert.equal(selfRulingRefusal(tool, input, dir, childDirs), undefined, `${tool} ${JSON.stringify(input)}`);
    assert.equal(selfRulingRefusal(tool, input, dir, parentDirs), undefined, `parent ${tool}`);
  }
  assert.equal(selfRulingRefusal("bash", { command: "cat link" }, dir, childDirs), undefined);
  assert.equal(selfRulingRefusal("bash", { command: `ln -s ${H}/ruling.md link2` }, dir, childDirs), undefined);
});

// the second branch of the glob-directory check and the not-existing-`cd` check (found needed by removing each: see the report)
test("a glob write after a cd elsewhere is refused by the directory the line started in; a name below a cd that does not exist too", () => {
  const elsewhere = path.join(wt, "src");
  assert.equal(selfRulingRefusal("bash", { command: `cd ${elsewhere} && echo x ${GT} ru*.md` }, H, childDirs), SELF_RULING_REASON);
  assert.equal(selfRulingRefusal("bash", { command: `cd ${elsewhere} && echo x ${GT} ru*.md` }, root, childDirs), undefined);
  assert.equal(selfRulingRefusal("bash", { command: `cd ${root}/not-yet && echo x ${GT} ru*.md` }, root, childDirs), SELF_RULING_REASON);
});

// a write or edit tool call through a link: the result hook records the real path as self-written (toolWriteRuling), as it records a ruling name typed as such; the write is not refused
function rig(): { d: string; plan: string } {
  const d = fs.mkdtempSync(path.join(root, "tw-"));
  const plan = path.join(d, "plan.md");
  fs.writeFileSync(plan, "p");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  return { d, plan };
}
/** What the hook does after a write or edit of `abs`. */
function afterToolWrite(self: SelfRulings, abs: string): void {
  const real = toolWriteRuling(abs);
  if (real !== null) self.mark(real);
}

for (const tool of ["write", "edit"]) {
  test(`${tool} tool onto a link to the ruling: recorded as self-written, no plan approval`, { skip: !posix }, () => {
    const { d, plan } = rig();
    const link = path.join(d, "notes.md");
    fs.symlinkSync(path.join(d, "ruling.md"), link, "file");
    assert.equal(toolWriteRuling(link), path.join(d, "ruling.md"), "dangling link: resolved before the write");
    fs.writeFileSync(link, "APPROVED\n");
    const self = new SelfRulings();
    afterToolWrite(self, link);
    assert.equal(readPlanVerdict(d, plan, self), null);
    assert.deepEqual(readPlanVerdict(d, plan), { kind: "approve" }, "nothing recorded: the same file approves");
  });
}

test("control: the parent writes the child's ruling directly: nothing recorded for the child, the child reads approve", { skip: !posix }, () => {
  const { d, plan } = rig();
  fs.writeFileSync(path.join(d, "ruling.md"), "APPROVED\n");
  const self = new SelfRulings();
  assert.deepEqual(readPlanVerdict(d, plan, self), { kind: "approve" });
});

test("control: a tool write onto a link to a file with no ruling name records nothing", { skip: !posix }, () => {
  const { d, plan } = rig();
  fs.writeFileSync(path.join(d, "other.md"), "APPROVED\n");
  const link = path.join(d, "notes.md");
  fs.symlinkSync(path.join(d, "other.md"), link);
  assert.equal(toolWriteRuling(link), null);
  assert.equal(toolWriteRuling(path.join(d, "plain.md")), null);
  assert.equal(readPlanVerdict(d, plan, new SelfRulings()), null);
});

test("a ruling name typed as such is still recorded", { skip: !posix }, () => {
  const { d } = rig();
  assert.equal(toolWriteRuling(path.join(d, "ruling.md")), path.join(d, "ruling.md"));
});
