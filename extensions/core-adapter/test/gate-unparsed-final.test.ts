// Ledger item 17, second revision: (1) any line break after trimming makes a line "more than one line" (`\r\n`, form feed or vertical tab before the newline);
// (2) the statements before a parse error nested in `$( )` keep their floors; (3) the protected-target check reads the statements before a top-level parse error.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";
import { baseFloorEnv, gateDecide, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { ProtectedEntry } from "../permconfig.ts";

process.env.PI_OFFLINE = "1";
const base = fs.realpathSync(mkTestTmp("pf-unparsed-final-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
for (const d of [wt, scr, out, path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Role = "main" | "explorer" | "builder" | "reviewer" | "headless";
const ROLES: Role[] = ["main", "explorer", "builder", "reviewer", "headless"];
const MODES = ["allow", "judge"] as const;

function rootsOf(role: Role): GateRoots {
  const main = role === "main" || role === "headless";
  return {
    worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [],
    child: !main, role: main ? "foreman" : role, tmpAccess: false, ...(role === "reviewer" || role === "explorer" ? { roundReadOnly: true } : {}),
  };
}
function gate(command: string, role: Role, mode: (typeof MODES)[number]) {
  const main = role === "main" || role === "headless";
  const o = gateEvaluate("bash", { command }, wt, {
    env: (c) => baseFloorEnv(c, main ? {} : { child: true, scratch: [scr, out], out, ...(role === "builder" ? { builder: true } : { readOnlyChild: true }) }),
    roots: () => rootsOf(role),
    ...(mode === "judge" ? { unclassified: "judge" as const } : {}),
  });
  const r = o.result as { allow?: boolean; block?: boolean; ask?: boolean; rule?: string } | undefined;
  return { result: r, danger: o.danger?.name ?? null };
}

// the spellings of a line break bash honours after trimming: a carriage return, form feed or vertical tab before the newline, also after a comment
const BREAKS: Record<string, string> = {
  "CRLF": "touch X\r\nfi",
  "CRLF after a comment": "touch X #c\r\nfi",
  "form feed before the newline": "touch X\f\nfi",
  "vertical tab before the newline": "touch X\v\nfi",
  "blanks, a carriage return and a comment": "touch X \t #c \r\nfi",
  "git reset after a comment, CRLF": "git reset --hard HEAD~3 #\r\nfi",
  "pkill after a comment, CRLF": "pkill -f node #\r\nfi",
};
for (const role of ROLES) {
  for (const mode of MODES) {
    test(`${role}, unclassified ${mode}: a CR, form feed or vertical tab before the newline still judges a line that does not parse`, { skip: posixOnly }, () => {
      for (const [name, line] of Object.entries(BREAKS)) {
        const g = gate(line, role, mode);
        if (g.result?.block) continue;
        assert.ok(!g.result?.allow, `${name}: not a silent allow: ${JSON.stringify(g)}`);
        assert.ok(g.danger !== null, `${name}: labelled: ${JSON.stringify(g)}`);
        assert.ok(g.result === undefined || g.result.ask, `${name}: ${JSON.stringify(g)}`);
      }
    });
  }
}

test("the break forms are labelled danger-unparsed where no other label comes first", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const name of ["CRLF", "CRLF after a comment", "form feed before the newline", "vertical tab before the newline", "blanks, a carriage return and a comment"]) {
      const g = gate(BREAKS[name], role, "allow");
      if (g.result?.block) continue;
      assert.equal(g.danger, "danger-unparsed", `${role} ${name}: ${JSON.stringify(g)}`);
    }
  }
});

test("a single line with a trailing carriage return or form feed is not labelled danger-unparsed", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const line of ["echo )\r", "touch X; fi\f", "echo a\r\n", "\r\necho )"]) {
      assert.notEqual(gate(line, role, "allow").danger, "danger-unparsed", `${role}: ${JSON.stringify(line)}`);
    }
  }
});

// a statement before a parse error nested in `$( )` keeps the outcome of the same statement without the error line
const HEADS: Record<string, string> = {
  "secret path read": "cat .env",
  "recursive delete outside": "rm -rf /opt/x",
  "force push to the default branch": "git push --force origin main",
  "write outside the worktree": "touch /nonexistent/x",
  "project settings write": "echo hi > .pi/settings.json",
};
for (const [name, head] of Object.entries(HEADS)) {
  for (const tail of ["fi", "done"]) {
    test(`${name} inside $( ) before a parse error (${tail}): same outcome as without the error line`, { skip: posixOnly }, () => {
      let floored = false;
      for (const role of ROLES) {
        for (const mode of MODES) {
          const ref = gate(`echo $(${head})`, role, mode);
          const got = gate(`echo $(${head}\n${tail})`, role, mode);
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

test("a backtick substitution and a quoted one keep the floors of their statements before the error", { skip: posixOnly }, () => {
  for (const [line, ref] of [["echo `cat .env\nfi`", "echo `cat .env`"], ['echo "$(rm -rf /opt/x\nfi)"', 'echo "$(rm -rf /opt/x)"']]) {
    for (const role of ROLES) {
      const want = gate(ref, role, "allow").result;
      assert.ok(want?.block || want?.ask, `${role}: reference is floored: ${ref}`);
      assert.deepEqual(gate(line, role, "allow").result, want, `${role}: ${JSON.stringify(line)}`);
    }
  }
});

// the protected-target check reads the statements before a top-level parse error
const E = (kind: ProtectedEntry["kind"], glob: string, i: number): ProtectedEntry => ({ id: `P${i}`, kind, glob, source: "user" });
test("a protected command before a parse error asks for the owner, as the same command without the error does", { skip: posixOnly }, () => {
  const entries = [E("command", "deploy-*", 1)];
  const g = (command: string) => gateDecide("bash", { command }, wt, { env: (c) => baseFloorEnv(c, {}), roots: () => rootsOf("main"), protected: entries }) as { ask?: boolean; cause?: string; rule?: string } | undefined;
  const ref = g("deploy-x now");
  assert.ok(ref?.ask && ref.cause === "protected", JSON.stringify(ref));
  for (const line of ["deploy-x now\nfi", "deploy-x now\r\nfi", `deploy-x now\necho "never closed`]) {
    const got = g(line);
    assert.ok(got?.ask && got.cause === "protected", `${JSON.stringify(line)}: ${JSON.stringify(got)}`);
    assert.equal(got.rule, ref.rule);
  }
});
