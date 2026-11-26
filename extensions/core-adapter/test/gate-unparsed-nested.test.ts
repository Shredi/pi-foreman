// Ledger item 17 revision: a multi-line line with a parse error nested anywhere (`$( )`, backticks, `"$( )"`, `<( )`, an expanded here-document body) is judge-first (`danger-unparsed`)
// in every role, and the segment floors of the statements before a parse error keep their outcome (the same line without the trailing error line is the reference).
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
const base = fs.realpathSync(mkTestTmp("pf-unparsed-nested-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
for (const d of [wt, scr, out, path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Role = "main" | "explorer" | "builder" | "reviewer" | "headless";
const ROLES: Role[] = ["main", "explorer", "builder", "reviewer", "headless"];
const MODES = ["allow", "judge"] as const;

const NESTED: Record<string, string> = {
  "command substitution": "echo $(touch X\nfi)",
  "backticks": "echo `touch X\nfi`",
  "quoted command substitution": 'echo "$(touch X\nfi)"',
  "process substitution": "cat <(touch X\nfi)",
  "expanded here-document body": "cat <<EOF\n$(touch X\nfi)\nEOF",
};

function gate(command: string, role: Role, mode: (typeof MODES)[number]) {
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
  const r = o.result as { allow?: boolean; block?: boolean; ask?: boolean; rule?: string } | undefined;
  return { result: r, danger: o.danger?.name ?? null };
}

for (const role of ROLES) {
  for (const mode of MODES) {
    test(`${role}, unclassified ${mode}: a nested parse error on a multi-line line is judged (danger-unparsed)`, { skip: posixOnly }, () => {
      for (const [name, line] of Object.entries(NESTED)) {
        const g = gate(line, role, mode);
        if (g.result?.block) continue;
        assert.ok(!g.result?.allow, `${name}: not a silent allow: ${JSON.stringify(g)}`);
        assert.equal(g.danger, "danger-unparsed", `${name}: ${JSON.stringify(g)}`);
      }
    });
  }
}

test("a nested form that parses, or a single-line nested error, is not labelled danger-unparsed", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const line of ["echo $(echo a\necho b)", "echo $( fi )", "echo `fi`"]) {
      assert.notEqual(gate(line, role, "allow").danger, "danger-unparsed", `${role}: ${line}`);
    }
  }
});

const CLEAR = JSON.stringify({ verdict: "clear", reason: "reads only" });
const UNSURE = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });

for (const child of [false, true]) {
  test(`handler, ${child ? "child" : "main"}: a nested parse error is asked of the judge; clear runs, unsure is refused`, { skip: posixOnly }, async (t) => {
    for (const [name, line] of Object.entries(NESTED)) {
      const yes = await labelRig(t, { child, gate: { unclassified: "allow" }, reply: CLEAR });
      const ok = await yes.r.call("bash", { command: line });
      if (yes.prompts.length === 0) {
        assert.ok(ok?.block === true, `${name}: refused before the judge: ${JSON.stringify(ok)}`);
        continue;
      }
      assert.match(yes.prompts.join("\n"), /danger-unparsed/, name);
      assert.notEqual(ok?.block, true, `${name}: clear runs: ${JSON.stringify(ok)}`);
      const no = await labelRig(t, { child, gate: { unclassified: "allow" }, reply: UNSURE });
      const refused = await no.r.call("bash", { command: line });
      assert.ok(no.prompts.length > 0, `${name}: the judge was asked`);
      assert.equal(refused?.block, true, `${name}: unsure is refused`);
    }
  });
}

// a segment floor in the statements before the error keeps its outcome: the same line without the trailing error line is the reference
const PREFIX: Record<string, string> = {
  "secret path read": "cat .env",
  "write outside the worktree": "touch /nonexistent/x",
  "write into the round worktree": "touch wt-file",
  "project settings write": "echo hi > .pi/settings.json",
};
for (const [name, head] of Object.entries(PREFIX)) {
  for (const tail of ["fi", `echo "never closed`]) {
    test(`${name} before a parse error (${tail}): same outcome as without the error line`, { skip: posixOnly }, () => {
      let floored = false;
      for (const role of ROLES) {
        for (const mode of MODES) {
          const ref = gate(head, role, mode);
          const got = gate(`${head}\n${tail}`, role, mode);
          if (ref.result?.block || ref.result?.ask) {
            floored = true;
            assert.deepEqual(got.result, ref.result, `${role} ${mode}: ${JSON.stringify({ ref, got })}`);
          }
        }
      }
      assert.ok(floored, "some role meets a floor on the reference line");
    });
  }
}
