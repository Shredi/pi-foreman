// PR C: `danger-harness-folder`, `danger-opaque`, `danger-install` and a main session's `danger-write-outside` left the judge-first list, so every row below carries
// no label and keeps its verdict. Ledger 18(a), 18(b), as they were: `danger-harness-folder` also fired for an unknown program naming the harness folder `<agent dir>/pi-foreman` itself or a path below it
// (label only), except the session's own handoff, scratch and wait folders; and pins of today's `danger-opaque` and `danger-install` labels. Each row compares the
// literal verdict and the full sorted label list.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateEvaluate } from "../gate.ts";
import type { FloorEnv } from "../floors.ts";
import { dangerSegment } from "../defaults.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";
import { strRaw } from "../strof.ts";

// the A rows put host paths (backslashes on a win32 host) into the shell text, where a posix shell parser drops unquoted backslashes: they run on a posix host only
const base = fs.realpathSync.native(mkTestTmp("pf-r2-hf-label-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const work = path.join(base, "work");
const scr = path.join(base, "scr");
const agent = path.join(home, ".pi", "agent");
const HF = path.join(agent, "pi-foreman");
const OWN = path.join(HF, "handoffs", "h1");
const CHILD = path.join(HF, "handoffs", "h2");
const OTHER = path.join(HF, "handoffs", "other");
for (const d of [work, scr, OWN, CHILD, OTHER, path.join(HF, "state", "wait")]) fs.mkdirSync(d, { recursive: true });
const GT = String.fromCharCode(62);
const LT = String.fromCharCode(60);
const SECRET = "." + "env";

type Role = "main" | "builder" | "reviewer" | "explorer";
const roots = (role: Role) => ({
  worktree: work, scratch: [scr], tmp: [], scratchBase: path.join(base, "sb"), owned: [path.join(HF, "handoffs"), HF], install: [], roundFlow: [],
  handoffs: role === "main" ? [OWN] : [], ...(role === "main" ? { childHandoffs: [CHILD] } : { childHandoff: CHILD }),
  child: role !== "main", role: role === "main" ? "foreman" : role, tmpAccess: true, agentDir: agent, home,
  ...(role === "reviewer" || role === "explorer" ? { roundReadOnly: true } : {}),
}) as never;
const envOf = (child: boolean): FloorEnv => ({ cwd: work, home, agentDir: agent, writeRoots: [work, scr], scratch: [scr], child });
const facts = { currentBranch: () => "feature/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
interface Got { verdict: string; labels: string[] }
const got = (role: Role, line: string): Got => {
  const o = gateEvaluate("bash", { command: line }, work, { env: () => envOf(role !== "main"), roots: () => roots(role), facts });
  const r = o.result as Record<string, unknown> | undefined;
  const verdict = r?.block ? `block ${strRaw(r.rule)}` : r?.allow ? `allow ${strRaw(r.rule)}` : "undecided";
  return { verdict, labels: [...(o.dangers ?? [])].sort() };
};
const row = (role: Role, line: string, verdict: string, labels: string[]): void => assert.deepEqual(got(role, line), { verdict, labels }, `${role}: ${line.replaceAll(base, "<base>")}`);

test("A: an unknown program naming the harness folder itself carries no label in C, for main and builder; the verdict is unchanged", { skip: posixOnly }, () => {
  for (const role of ["main", "builder"] as const) {
    for (const l of [`ditto d ${HF}`, `bsdtar -xf a.tar -C ${HF}`, `gtar -xf a.tar -C ${HF}`, `rclone copy d ${HF}`, `foo x ${HF}`, `foo x ${HF}/`, `foo x ${HF}/other.txt`, `foo x ${HF}/handoffs`]) row(role, l, "undecided", []);
  }
});

test("A: the reviewer's unknown-program lines carry no label", { skip: posixOnly }, () => {
  for (const l of [`ditto d ${HF}`, `foo x ${HF}`, `foo x ${HF}/other.txt`]) row("reviewer", l, "undecided", []);
});

test("A: tar and rsync keep their floor; lines already blocked or labelled keep their outcome", { skip: posixOnly }, () => {
  for (const role of ["main", "builder", "reviewer"] as const) {
    for (const l of [`tar -xf a.tar -C ${HF}`, `rsync -a d ${HF}`, `rsync -a d ${HF}/state/`]) row(role, l, "block floor-overwrite-outside", []);
    for (const l of [`foo x ${HF}/permissions.json`, `foo ${HF}/*`]) row(role, l, "block floor-policy-file", []);
  }
  for (const role of ["main", "builder"] as const) row(role, `mytool ${LT} ${HF}/managed.json`, "undecided", []);
});

test("A: known reads of the folder stay unlabelled", { skip: posixOnly }, () => {
  for (const role of ["main", "builder"] as const) {
    // plan D2: reads anywhere except secret paths are the fast allow `default-read`, no label
    for (const l of [`cat ${HF}`, `ls ${HF}`, `grep x ${HF}`]) row(role, l, "allow default-read", []);
  }
});

test("A exclusion: the session's own handoff, its child's handoff and its scratch dir gain no label (outcome of the base commit)", { skip: posixOnly }, () => {
  row("main", `echo x ${GT} ${OWN}/ask.md`, "undecided", []);
  row("main", `cat ${OWN}/brief.md`, "allow default-read", []);
  row("main", `foo ${OWN}/x`, "undecided", []);
  row("main", `cp a ${OWN}/result.md`, "undecided", []);
  row("main", `foo ${CHILD}/x`, "undecided", []);
  // echo is a List A program (plan D2): a write into an own root is `default-write-in`, like the cp below
  row("builder", `echo x ${GT} ${CHILD}/ask.md`, "allow default-write-in", []);
  row("builder", `foo ${CHILD}/x`, "undecided", []);
  row("builder", `cp a ${CHILD}/result.md`, "allow default-write-in", []);
  row("reviewer", `foo ${CHILD}/x`, "undecided", []);
  row("reviewer", `cp a ${CHILD}/result.md`, "allow default-write-in", []);
  row("main", `foo ${scr}/x`, "undecided", []);
});

test("A exclusion: the wait folder gains no label (outcome of the base commit)", { skip: posixOnly }, () => {
  const W = path.join(HF, "state", "wait", "f");
  row("main", `echo x ${GT} ${W}`, "undecided", []);
  row("main", `foo ${W}`, "undecided", []);
  row("main", `touch ${W}`, "undecided", []);
  for (const l of [`echo x ${GT} ${W}`, `touch ${W}`]) {
    row("builder", l, "block selfmod-state", []);
    row("reviewer", l, "block selfmod-state", []);
  }
  row("builder", `foo ${W}`, "block selfmod-state-read", []);
});

test("A: another session's handoff dir carries no label", { skip: posixOnly }, () => {
  for (const role of ["main", "builder"] as const) row(role, `foo ${OTHER}/x`, "undecided", []);
  row("reviewer", `foo ${OTHER}/x`, "undecided", []);
  row("main", `echo x ${GT} ${OTHER}/x`, "undecided", []);
  row("builder", `echo x ${GT} ${OTHER}/x`, "block child-write-outside", []);
  row("main", `foo x ${GT} ${HF}/n.txt`, "undecided", []);
});

test("A: a win32 spelling of the folder carries no label on a win32 rig", () => {
  const AG = "C:\\Users\\u\\.pi\\agent";
  const r = { worktree: "C:\\w\\proj", scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, agentDir: AG, home: "C:\\Users\\u", realpath: () => null } as never;
  const floor: FloorEnv = { platform: "win32", cwd: "C:\\w\\proj", home: "C:\\Users\\u", agentDir: AG, resolver: () => null };
  const env = { roots: r, platform: "win32", cwd: "C:\\w\\proj", facts, floor };
  // the shell parser of a posix host drops unquoted backslashes: the backslash spellings are quoted words
  const label = (line: string): string | null => dangerSegment(parseShell(line, { cwd: "C:\\w\\proj", platform: "win32" })[0], env);
  assert.equal(label(`foo x '${AG}\\pi-foreman'`), null);
  assert.equal(label(`foo x '${AG}\\pi-foreman\\other.txt'`), null);
  assert.equal(label("foo x C:/USERS/U/.pi/agent/PI-FOREMAN/other.txt"), null);
  assert.equal(label("foo x a.txt"), null);
});

// ------------------------------------------------------------------ part B: pins of today's labels
const nl = (...l: string[]): string => l.join("\n");

test("B1: a heredoc or pipe fed to a shell is judge-first (danger-inline-code) for every role, the shell's stdin is no text the gate reads", () => {
  const lines = [
    nl("cat <<'EOT' | sh", `cat ${SECRET}`, "EOT"),
    nl("sh <<EOT", `cat ${SECRET}`, "EOT"),
    `echo 'cat ${SECRET}' | sh`,
    `echo 'cat ${SECRET}' | bash`,
    `echo 'cat ${SECRET}' | sh -s`,
  ];
  for (const l of lines) {
    for (const role of ["main", "builder", "reviewer", "explorer"] as const) row(role, l, "undecided", ["danger-inline-code"]);
  }
});

test("B1: a closed heredoc fed to cat is cat's data: no label", () => {
  // plan D2: a here-doc fed to a read program is data, the line is the fast allow `default-read`
  for (const role of ["main", "builder", "reviewer", "explorer"] as const) row(role, nl("cat <<EOT", `cat ${SECRET}`, "EOT"), "allow default-read", []);
});

test("B1: an unclosed heredoc fed to cat (no end line) gets no label either", () => {
  for (const role of ["main", "builder", "reviewer", "explorer"] as const) row(role, nl("cat <<EOT", `cat ${SECRET}`), "allow default-read", []);
});

test("B2: an opaque line and an env-prefixed install carry no label", () => {
  for (const role of ["main", "builder"] as const) {
    row(role, "npm ci $X", "undecided", []);
    row(role, "FOO=1 npm ci", "undecided", []);
    row(role, "npm ci", "undecided", []);
  }
  for (const role of ["reviewer", "explorer"] as const) row(role, "npm ci $X", "undecided", []);
});
