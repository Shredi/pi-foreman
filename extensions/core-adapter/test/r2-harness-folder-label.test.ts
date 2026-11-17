// Ledger 18(a), 18(b): `danger-harness-folder` also fires for an unknown program naming the harness folder `<agent dir>/pi-foreman` itself or a path below it
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

// the A rows put host paths (backslashes on a win32 host) into the shell text, where a posix shell parser drops unquoted backslashes: they run on a posix host only
const posix = process.platform !== "win32";
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
  const verdict = r?.block ? `block ${r.rule}` : r?.allow ? `allow ${r.rule}` : "undecided";
  return { verdict, labels: [...(o.dangers ?? [])].sort() };
};
const HFL = "danger-harness-folder";
const RO = "danger-readonly-run";
const row = (role: Role, line: string, verdict: string, labels: string[]): void => assert.deepEqual(got(role, line), { verdict, labels }, `${role}: ${line.replaceAll(base, "<base>")}`);

test("A: an unknown program naming the harness folder itself is labelled danger-harness-folder, for main and builder; the verdict is unchanged", { skip: !posix }, () => {
  for (const role of ["main", "builder"] as const) {
    for (const l of [`ditto d ${HF}`, `bsdtar -xf a.tar -C ${HF}`, `gtar -xf a.tar -C ${HF}`, `rclone copy d ${HF}`, `foo x ${HF}`, `foo x ${HF}/`, `foo x ${HF}/other.txt`, `foo x ${HF}/handoffs`]) row(role, l, "undecided", [HFL]);
  }
});

test("A: the reviewer's unknown-program lines keep danger-readonly-run and gain the label", { skip: !posix }, () => {
  for (const l of [`ditto d ${HF}`, `foo x ${HF}`, `foo x ${HF}/other.txt`]) row("reviewer", l, "undecided", [HFL, RO]);
});

test("A: tar and rsync keep their floor; lines already blocked or labelled keep their outcome", { skip: !posix }, () => {
  for (const role of ["main", "builder", "reviewer"] as const) {
    for (const l of [`tar -xf a.tar -C ${HF}`, `rsync -a d ${HF}`, `rsync -a d ${HF}/state/`]) row(role, l, "block floor-overwrite-outside", []);
    for (const l of [`foo x ${HF}/permissions.json`, `foo ${HF}/*`]) row(role, l, "block floor-policy-file", []);
  }
  for (const role of ["main", "builder"] as const) row(role, `mytool ${LT} ${HF}/managed.json`, "undecided", [HFL]);
});

test("A: known reads of the folder stay unlabelled", { skip: !posix }, () => {
  for (const role of ["main", "builder"] as const) {
    for (const l of [`cat ${HF}`, `ls ${HF}`, `grep x ${HF}`]) row(role, l, "undecided", []);
  }
});

test("A exclusion: the session's own handoff, its child's handoff and its scratch dir gain no label (outcome of the base commit)", { skip: !posix }, () => {
  row("main", `echo x ${GT} ${OWN}/ask.md`, "undecided", ["danger-write-outside"]);
  row("main", `cat ${OWN}/brief.md`, "allow default-read", []);
  row("main", `foo ${OWN}/x`, "undecided", []);
  row("main", `cp a ${OWN}/result.md`, "undecided", ["danger-write-outside"]);
  row("main", `foo ${CHILD}/x`, "undecided", []);
  row("builder", `echo x ${GT} ${CHILD}/ask.md`, "undecided", []);
  row("builder", `foo ${CHILD}/x`, "undecided", []);
  row("builder", `cp a ${CHILD}/result.md`, "allow default-write-in", []);
  row("reviewer", `foo ${CHILD}/x`, "undecided", [RO]);
  row("reviewer", `cp a ${CHILD}/result.md`, "allow default-write-in", []);
  row("main", `foo ${scr}/x`, "undecided", []);
});

test("A exclusion: the wait folder gains no label (outcome of the base commit)", { skip: !posix }, () => {
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

test("A: another session's handoff dir is labelled (the harness folder, outside the session's own dirs)", { skip: !posix }, () => {
  for (const role of ["main", "builder"] as const) row(role, `foo ${OTHER}/x`, "undecided", [HFL]);
  row("reviewer", `foo ${OTHER}/x`, "undecided", [HFL, RO]);
  row("main", `echo x ${GT} ${OTHER}/x`, "undecided", [HFL, "danger-write-outside"]);
  row("builder", `echo x ${GT} ${OTHER}/x`, "block child-write-outside", []);
  row("main", `foo x ${GT} ${HF}/n.txt`, "undecided", [HFL, "danger-write-outside"]);
});

test("A: a win32 spelling of the folder is labelled on a win32 rig", () => {
  const AG = "C:\\Users\\u\\.pi\\agent";
  const r = { worktree: "C:\\w\\proj", scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, agentDir: AG, home: "C:\\Users\\u", realpath: () => null } as never;
  const floor: FloorEnv = { platform: "win32", cwd: "C:\\w\\proj", home: "C:\\Users\\u", agentDir: AG, resolver: () => null };
  const env = { roots: r, platform: "win32", cwd: "C:\\w\\proj", facts, floor };
  // the shell parser of a posix host drops unquoted backslashes: the backslash spellings are quoted words
  const label = (line: string): string | null => dangerSegment(parseShell(line, { cwd: "C:\\w\\proj", platform: "win32" })[0], env);
  assert.equal(label(`foo x '${AG}\\pi-foreman'`), HFL);
  assert.equal(label(`foo x '${AG}\\pi-foreman\\other.txt'`), HFL);
  assert.equal(label("foo x C:/USERS/U/.pi/agent/PI-FOREMAN/other.txt"), HFL);
  assert.equal(label("foo x a.txt"), null);
});

// ------------------------------------------------------------------ part B: pins of today's labels
const OPAQUE = "danger-opaque";
const nl = (...l: string[]): string => l.join("\n");

test("B1: a heredoc or pipe fed to a shell is labelled danger-opaque for every role; the read-only roles add danger-readonly-run", () => {
  const lines = [
    nl("cat <<'EOT' | sh", `cat ${SECRET}`, "EOT"),
    nl("sh <<EOT", `cat ${SECRET}`, "EOT"),
    `echo 'cat ${SECRET}' | sh`,
    `echo 'cat ${SECRET}' | bash`,
    `echo 'cat ${SECRET}' | sh -s`,
  ];
  for (const l of lines) {
    for (const role of ["main", "builder"] as const) row(role, l, "undecided", [OPAQUE]);
    for (const role of ["reviewer", "explorer"] as const) row(role, l, "undecided", [OPAQUE, RO]);
  }
});

test("B1: a closed heredoc fed to cat is cat's data: no label", () => {
  for (const role of ["main", "builder", "reviewer", "explorer"] as const) row(role, nl("cat <<EOT", `cat ${SECRET}`, "EOT"), "undecided", []);
});

test("B1: an unclosed heredoc fed to cat (no end line) gets no label either", () => {
  for (const role of ["main", "builder", "reviewer", "explorer"] as const) row(role, nl("cat <<EOT", `cat ${SECRET}`), "undecided", []);
});

test("B2: an opaque line that is not an assignment prefix gets no install label; an env prefix does get it", () => {
  for (const role of ["main", "builder"] as const) {
    row(role, "npm ci $X", "undecided", [OPAQUE]);
    row(role, "FOO=1 npm ci", "undecided", ["danger-install", OPAQUE]);
    row(role, "npm ci", "undecided", ["danger-install"]);
  }
  for (const role of ["reviewer", "explorer"] as const) row(role, "npm ci $X", "undecided", [OPAQUE, RO]);
});
