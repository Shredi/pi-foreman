// Ledger item 17 (owner 2026-11-25): a multi-line shell line that does not parse (one `parse_error` segment) no longer runs unchecked: it is judge-first (`danger-unparsed`)
// in every role and both `gate.unclassified` modes. Gate level per role and mode; handler level with a fake judge (clear runs, unsure is refused with no dialog).
// A single-line syntax error runs a shell with no statement at all (nothing before the error), so it stays unlabelled.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { labelRig } from "./_judge-label.ts";

process.env.PI_OFFLINE = "1";
const base = fs.realpathSync(mkTestTmp("pf-unparsed-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
for (const d of [wt, scr, out]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Role = "main" | "explorer" | "builder" | "reviewer" | "headless";
const ROLES: Role[] = ["main", "explorer", "builder", "reviewer", "headless"];
type Mode = "allow" | "judge";
const MODES: Mode[] = ["allow", "judge"];

const LINES: Record<string, string> = {
  "write then a lone fi": "touch /nonexistent/x\nfi",
  "unterminated quote after a write": `touch /nonexistent/x\necho "never closed`,
};
// The unterminated heredoc is no parse error (the parser reads the body to the end of the text), so item 17 does not touch it: a child's write into the home folder is
// judge-first as `danger-write-outside` already, and the main session's own write guard decides its home writes as before.
const HEREDOC = "cat > ~/pf-unparsed-probe <<EOF\nbody that never ends";

function gate(command: string, role: Role, mode: Mode) {
  const main = role === "main" || role === "headless";
  const roots: GateRoots = {
    worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [],
    child: !main, role: main ? "foreman" : role, tmpAccess: false, ...(role === "reviewer" || role === "explorer" ? { roundReadOnly: true } : {}),
  };
  const o = gateEvaluate("bash", { command }, wt, {
    env: (c) => baseFloorEnv(c, main ? {} : { child: true, scratch: [scr, out], out, ...(role === "builder" ? { builder: true } : { readOnlyChild: true }) }),
    roots: () => roots,
    ...(mode === "judge" ? { unclassified: "judge" as const } : {}),
  });
  return { result: o.result as { allow?: boolean; block?: boolean; ask?: boolean } | undefined, danger: o.danger?.name ?? null };
}

for (const role of ROLES) {
  for (const mode of MODES) {
    test(`${role}, unclassified ${mode}: a multi-line line that does not parse is judged (danger-unparsed), not silent`, { skip: posixOnly }, () => {
      for (const [name, line] of Object.entries(LINES)) {
        const g = gate(line, role, mode);
        // a child floor or the read-only write fence may refuse first; otherwise the line is judge-first under the label
        if (g.result?.block) continue;
        assert.ok(!g.result?.allow, `${name}: not a silent allow`);
        assert.equal(g.danger, "danger-unparsed", `${name}: ${JSON.stringify(g)}`);
      }
    });
  }
}

for (const role of ["explorer", "builder", "reviewer"] as const) {
  test(`${role}: an unterminated heredoc after a redirect into the home folder is judged (danger-write-outside)`, { skip: posixOnly }, () => {
    for (const mode of MODES) {
      const g = gate(HEREDOC, role, mode);
      assert.ok(g.result?.block === true || g.danger === "danger-write-outside", JSON.stringify(g));
    }
  });
}

test("a single-line syntax error stays as it was (nothing runs before the error), and a parsing multi-line line is not labelled", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const mode of MODES) {
      assert.notEqual(gate("echo )", role, mode).danger, "danger-unparsed", `${role} ${mode}`);
      assert.notEqual(gate("echo a\necho b", role, mode).danger, "danger-unparsed", `${role} ${mode}`);
    }
  }
});

const CLEAR = JSON.stringify({ verdict: "clear", reason: "reads only" });
const UNSURE = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });

for (const child of [false, true]) {
  for (const unclassified of ["allow", "judge"]) {
    test(`handler, ${child ? "child" : "main"}, unclassified ${unclassified}: the judge is asked; clear runs, unsure is refused with no dialog`, { skip: posixOnly }, async (t) => {
      for (const [name, line] of Object.entries(LINES)) {
        const yes = await labelRig(t, { child, gate: { unclassified }, reply: CLEAR });
        const ok = await yes.r.call("bash", { command: line });
        // the main session's shell-write guard (index.ts) refuses a write it cannot read before the gate: a refusal, never a silent run
        if (yes.prompts.length === 0) {
          // a child's write outside its worktree before the error keeps its floor refusal (item 17 revision), the judge is never asked
          assert.ok((!child && ok?.block === true && /shell write into project files refused/.test(String(ok.reason))) || (child && ok?.block === true && /child-write-outside/.test(String(ok.reason))), `${name}: ${JSON.stringify(ok)}`);
          continue;
        }
        assert.match(yes.prompts.join("\n"), /danger-unparsed/, name);
        assert.notEqual(ok?.block, true, `${name}: clear runs: ${JSON.stringify(ok)}`);
        const no = await labelRig(t, { child, gate: { unclassified }, reply: UNSURE });
        const refused = await no.r.call("bash", { command: line });
        assert.ok(no.prompts.length > 0, `${name}: the judge was asked`);
        assert.equal(refused?.block, true, `${name}: unsure is refused`);
      }
    });
  }
}
