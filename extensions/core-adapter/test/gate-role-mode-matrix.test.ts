// Plan gate-verify D3, ledger items 2 and 3: the role x mode matrix of the permission gate. Roles: the main session, every child role (explorer, builder, reviewer) and a headless
// session (main without a UI); modes: `gate.unclassified` allow and judge. Pinned per construct and role: a dangerous payload is never silent (Property A, both modes, through every
// construct); a harmless line never asks the owner and never blocks (both modes); the judge mode only ever adds looks (its class is never looser than the allow mode's, and equals it
// for every line that carries a label already); the allow mode is today's matrix (ROLE_MATRIX). Handler level: headless and every child role, harmless lines run with no dialog.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { posixOnly } from "./_platform.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { CONSTRUCTS, DANGEROUS, FIXED, HARMLESS, KNOWN_GAPS, RANK, ROLE_MATRIX, WRAPS, buildCommand, letterOf, makeLayout, type Cls, type Layout, type MatrixRole } from "./_gate-gen.ts";

process.env.PI_OFFLINE = "1";
const base = fs.realpathSync(mkTestTmp("pf-role-mode-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const layout: Layout = makeLayout(path.join(base, "matrix"));

type Mode = "allow" | "judge";
type GateRole = "main" | "explorer" | "builder" | "reviewer" | "headless";
const MODES: readonly Mode[] = ["allow", "judge"];
const GATE_ROLES: readonly GateRole[] = ["main", "explorer", "builder", "reviewer", "headless"];
const CHILD_ROLES = ["explorer", "builder", "reviewer"] as const;
type Res = { allow?: boolean; block?: boolean; ask?: boolean } | undefined;

/** `gateEvaluate` of one role in one mode, as the handler wires it. Explorer and reviewer read their round worktree (read-only child); a headless session is the main session's gate (the UI only matters after the gate). */
function classOf(command: string, role: GateRole, mode: Mode): Cls {
  const l = layout;
  const main = role === "main" || role === "headless";
  const roots: GateRoots = main
    ? { worktree: l.worktree, scratch: [l.scratch[0]], tmp: [], scratchBase: l.scratchBase, owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false }
    : {
      worktree: l.worktree, scratch: l.scratch, ...(l.out ? { out: l.out } : {}), tmp: [], scratchBase: l.scratchBase, owned: [], install: [], roundFlow: [], handoffs: [],
      ...(l.handoff ? { childHandoff: l.handoff } : {}), child: true, role, tmpAccess: false, ...(role !== "builder" ? { roundReadOnly: true } : { builder: true }),
    };
  const env = (c: string) => (main
    ? baseFloorEnv(c, { scratch: [l.scratch[0]] })
    : baseFloorEnv(c, { child: true, scratch: l.scratch, ...(l.out ? { out: l.out } : {}), ...(role === "builder" ? { builder: true } : { readOnlyChild: true }) }));
  const o = gateEvaluate("bash", { command }, l.worktree, { env, roots: () => roots, ...(mode === "judge" ? { unclassified: "judge" as const } : {}) });
  const r = o.result as Res;
  return r?.block ? "block" : r?.ask ? "ask" : r?.allow ? "silent" : o.danger ? "judge" : "silent";
}

const letters = (role: GateRole, mode: Mode, payloads: readonly { text: string }[], c?: (typeof CONSTRUCTS)[number]): string =>
  payloads.map((p) => letterOf(classOf(c ? buildCommand([c], p.text) : p.text, role, mode))).join("");

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Dangerous classes pinned per role (plain lines)


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Dangerous classes: pinned per role (plain lines), then through every construct

/** The class of each DANGEROUS payload as a plain line, per role and mode (payload order: rm-outside, curl-sh, git-push, cred-read, write-outside, git-outside, rebase-push; s silent, j judge, a ask, b block).
 * The main session's `write-outside` and `git-outside` are silent in `allow`: its shell-write guard (index.ts) decides before the gate and it may write outside as far as the gate goes; `judge` looks at them. */
const PLAIN_DANGEROUS: Record<GateRole, Record<Mode, string>> = {
  main: { allow: "bbbbssj", judge: "bbbbjjj" },
  headless: { allow: "bbbbssj", judge: "bbbbjjj" },
  builder: { allow: "bbbbjbj", judge: "bbbbjbj" },
  explorer: { allow: "bbbbbbb", judge: "bbbbbbb" },
  reviewer: { allow: "bbbbbbb", judge: "bbbbbbb" },
};

test("dangerous payloads as plain lines: the class is pinned per role and mode", { skip: posixOnly }, () => {
  for (const role of GATE_ROLES) for (const mode of MODES) assert.equal(letters(role, mode, DANGEROUS), PLAIN_DANGEROUS[role][mode], `[${role}, ${mode}] ${DANGEROUS.map((p) => p.name).join(", ")}`);
});

/** Allow mode: the payloads that run silent for the main session (gate layer) and no other cell. */
const MAIN_SILENT = new Set(["write-outside", "git-outside"]);

test("property A in both modes: a dangerous payload is never silent through any construct, any role (allow: only the main session's two guarded-elsewhere payloads)", { skip: posixOnly }, () => {
  const bad: string[] = [];
  for (const role of GATE_ROLES) {
    for (const mode of MODES) {
      for (const c of [...WRAPS, ...FIXED]) {
        for (const p of DANGEROUS) {
          const cls = classOf(buildCommand([c], c.kind === "fixed" ? "" : p.text), role, mode);
          if (c.kind === "fixed") continue;
          const exempt = mode === "allow" && (role === "main" || role === "headless") && MAIN_SILENT.has(p.name);
          if (cls === "silent" && !exempt) bad.push(`[${role}, ${mode}] ${c.name} on ${p.name}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `dangerous lines run silent:\n${bad.slice(0, 12).join("\n")}`);
});

test("judge mode closes the marked gaps: the constructs KNOWN_GAPS names are judged or stricter for every payload and role", { skip: posixOnly }, () => {
  const names = new Set(KNOWN_GAPS.flatMap((g) => g.shape));
  assert.ok(names.size > 0);
  for (const role of GATE_ROLES) {
    for (const n of names) {
      const c = CONSTRUCTS.find((x) => x.name === n) as (typeof CONSTRUCTS)[number];
      for (const p of DANGEROUS) assert.notEqual(classOf(buildCommand([c], p.text), role, "judge"), "silent", `[${role}] ${n} on ${p.name}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Harmless classes: pinned per construct and role

/** Wrap constructs whose three harmless twins stay silent in `judge` mode (they hold only read programs and operators); every other wrap holds a part the code cannot classify (`:`, a substitution, a runner), so `judge` looks at it. Same for every role. */
const SILENT_IN_JUDGE = ["and", "bg", "brace", "negate", "or", "pipe", "redirect", "subshell", "timeout"];

test("harmless twins in both modes: never an owner ask or a block; allow = today's matrix; judge adds looks only on the constructs it names, the same for every role", { skip: posixOnly }, () => {
  const bad: string[] = [];
  for (const role of GATE_ROLES) {
    for (const c of WRAPS) {
      const allow = letters(role, "allow", HARMLESS, c);
      const judge = letters(role, "judge", HARMLESS, c);
      const pinned = ROLE_MATRIX[(role === "headless" ? "main" : role === "explorer" ? "reviewer" : role) as MatrixRole][c.name].slice(0, HARMLESS.length);
      if (allow !== pinned) bad.push(`[${role}] ${c.name}: allow mode ${allow}, matrix ${pinned}`);
      // the one standing block of a harmless twin: a read-only child's `find -exec` is blocked whatever it runs (floor child-readonly-write; ROLE_MATRIX pins it)
      const readOnlyFindExec = c.name === "find-exec" && (role === "explorer" || role === "reviewer");
      const want = readOnlyFindExec ? "bbb" : SILENT_IN_JUDGE.includes(c.name) ? "sss" : "jjj";
      if (judge !== want) bad.push(`[${role}] ${c.name}: judge mode ${judge}, pinned ${want}`);
      if (/[ab]/.test(allow + judge) && !readOnlyFindExec) bad.push(`[${role}] ${c.name}: a harmless line asks or blocks (${allow}/${judge})`);
    }
  }
  assert.deepEqual(bad, [], bad.slice(0, 12).join("\n"));
});

test("harmless plain lines (echo, ls, git status) are silent for every role in both modes: the fast allow covers them", { skip: posixOnly }, () => {
  for (const role of GATE_ROLES) for (const mode of MODES) assert.equal(letters(role, mode, HARMLESS), "sss", `[${role}, ${mode}]`);
});

test("judge mode is never looser than allow mode, and a line that is labelled in allow mode keeps its class", { skip: posixOnly }, () => {
  const bad: string[] = [];
  for (const role of GATE_ROLES) {
    for (const c of WRAPS) {
      for (const p of [...HARMLESS, ...DANGEROUS]) {
        const line = buildCommand([c], p.text);
        const a = classOf(line, role, "allow");
        const j = classOf(line, role, "judge");
        if (RANK[j] < RANK[a]) bad.push(`[${role}] ${c.name} on ${p.name}: allow ${a}, judge ${j}`);
        if (a !== "silent" && j !== a) bad.push(`[${role}] ${c.name} on ${p.name}: labelled ${a} in allow mode, ${j} in judge mode`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.slice(0, 12).join("\n"));
});

test("explorer and reviewer are the same read-only child at the gate layer; headless is the main session's gate; in both modes, over every construct and payload", { skip: posixOnly }, () => {
  const bad: string[] = [];
  for (const mode of MODES) {
    for (const c of WRAPS) {
      for (const p of [...HARMLESS, ...DANGEROUS]) {
        const line = buildCommand([c], p.text);
        if (classOf(line, "explorer", mode) !== classOf(line, "reviewer", mode)) bad.push(`explorer vs reviewer, ${mode}: ${c.name} on ${p.name}`);
        if (classOf(line, "headless", mode) !== classOf(line, "main", mode)) bad.push(`headless vs main, ${mode}: ${c.name} on ${p.name}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.slice(0, 12).join("\n"));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Handler level: every child role and a headless session, harmless lines in both modes

const HARMLESS_LINES = ["echo hi", "ls", "git status", "cat package.json | sort | uniq -c"];

async function handlerRig(t: Parameters<typeof r11Rig>[0], who: "headless" | (typeof CHILD_ROLES)[number], mode: Mode) {
  const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
  t.after(() => {
    if (saved.b === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved.b;
    if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
    else process.env.FOREMAN_CHECKOUT = saved.c;
  });
  if (who !== "headless") process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: who, launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  delete process.env.FOREMAN_CHECKOUT;
  const state = { judged: 0, selected: 0 };
  const modelRegistry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => (state.judged++, { content: [{ type: "text", text: JSON.stringify({ verdict: "refuse", reason: "stub" }) }], stopReason: "stop", usage: { input: 1, output: 1 } }),
  };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => (state.selected++, undefined), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
  const config = {
    presence: { enabled: false },
    gate: { reviewTimeoutMs: 100, unclassified: mode },
    providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } },
  };
  const rig = await r11Rig(t, {}, { ctx: { modelRegistry, ui, ...(who === "headless" ? { hasUI: false, mode: "print" } : {}) }, config, child: who !== "headless" });
  return { rig, state, dialogs: (): number => rig.events("dialog").filter((e) => e.guard === "gate").length };
}

for (const who of ["headless", ...CHILD_ROLES] as const) {
  for (const mode of MODES) {
    test(`handler (${who}, unclassified ${mode}): harmless lines run with no look and no dialog; a dangerous plain line never reaches the owner`, { skip: posixOnly }, async (t) => {
      const { rig, state, dialogs } = await handlerRig(t, who, mode);
      for (const command of HARMLESS_LINES) {
        const res = await rig.call("bash", { command });
        assert.equal(res, undefined, `${command}: ${JSON.stringify(res)}`);
      }
      assert.equal(state.judged, 0, "no judge look for a harmless line");
      assert.equal(dialogs(), 0);
      assert.equal(state.selected, 0);
      // rm outside every folder: a fixed floor blocks it, whoever asks
      const res = await rig.call("bash", { command: "rm -rf ~/x" });
      assert.equal(res?.block, true);
      assert.equal(dialogs(), 0);
      assert.equal(state.selected, 0);
    });
  }
}
