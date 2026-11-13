// rw4 plan section 1 (G8): one rule for the restart, privilege and disk floors. A real program of each group is refused in every position (the matrix
// recorded against the code before the change: every row below passed before and must pass after); a search with an escaped pipe in front of one of
// the words is harmless. Rows no judge refused before sit in the documented-gaps test with today's verdict. In-process, no child process.
// Test text with guarded words is data: nothing here runs as a shell line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDecide, baseFloorEnv } from "../gate.ts";
import { cleanLine, rawFloors } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { GAPS, GROUPS, HARMLESS, OPAQUE, POSITIONS, judge, label } from "./_g8matrix.ts";

const NOT = "not refused";

/** The verdict each opaque or runner form had before the change, restart / privilege / disk. A form refused by the word match alone stays refused because its line is not clean. */
const OPAQUE_PIN: Record<string, [string, string, string]> = {
  "function body": [NOT, NOT, NOT],
  exec: [NOT, NOT, NOT],
  "! negation": ["refused (structure)", "refused (structure)", "refused (structure)"],
  coproc: [NOT, NOT, NOT],
  "substitution in an assignment value": ["refused (structure)", "refused (both)", "refused (both)"],
  "substitution in a redirect target": ["refused (structure)", "refused (both)", "refused (both)"],
  "[[ $( ) ]]": [NOT, "refused (word)", "refused (word)"],
  "variable as command word": [NOT, NOT, NOT],
  "unquoted pipe into sh": [NOT, NOT, NOT],
  "python -e": [NOT, "refused (word)", "refused (word)"],
};

/** Forms no judge refused before: pinned as gaps, not as protection. `here-string into sh` is a gap of the position matrix. */
const GAP_ROWS = [...GAPS.filter((r) => r.form !== "python -e"), { form: "here-string into sh", line: POSITIONS.find((r) => r.form === "here-string into sh")!.line }];

test("every dangerous position of a restart, privilege and disk program is refused (rows refused before the change)", () => {
  for (const row of POSITIONS) {
    if (row.form === "here-string into sh") continue;
    for (const g of GROUPS) {
      const line = row.line(g);
      assert.equal(judge(line, g).refused, true, `${g.name} / ${row.form}: ${JSON.stringify(line)}`);
    }
  }
});

test("the opaque and runner forms keep the verdict they had before the change", () => {
  for (const row of OPAQUE) {
    const pin = OPAQUE_PIN[row.form];
    assert.ok(pin, row.form);
    GROUPS.forEach((g, i) => assert.equal(label(judge(row.line(g), g)), pin[i], `${g.name} / ${row.form}: ${JSON.stringify(row.line(g))}`));
  }
  const py = "python -e";
  const row = GAPS.find((r) => r.form === py)!;
  GROUPS.forEach((g, i) => assert.equal(label(judge(row.line(g), g)), OPAQUE_PIN[py][i], `${g.name} / ${py}`));
});

test("documented gaps: forms no judge reads as the program are not refused today (not a protection; closing them is a later round)", () => {
  for (const row of GAP_ROWS) {
    for (const g of GROUPS) assert.equal(judge(row.line(g), g).refused, false, `${g.name} / ${row.form}: ${JSON.stringify(row.line(g))}`);
  }
});

test("a search with an escaped pipe in front of a restart, privilege or disk word is not refused", () => {
  for (const row of HARMLESS) {
    for (const g of GROUPS) assert.equal(judge(row.line(g), g).refused, false, `${g.name} / ${row.form}: ${JSON.stringify(row.line(g))}`);
  }
});

test("a row refused by the word match alone is not a clean line, so the word match stays on it", () => {
  for (const rows of [POSITIONS, OPAQUE, GAPS]) {
    for (const row of rows) {
      for (const g of GROUPS) {
        const line = row.line(g);
        const v = judge(line, g);
        if (v.refused && v.word && !v.structure) assert.equal(cleanLine(parseShell(line, { cwd: process.cwd() })), false, `${g.name} / ${row.form}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("clean lines are the plain ones; a runner, a shell fed text, an opaque segment or a parse failure is not clean", () => {
  const clean = (l: string): boolean => cleanLine(parseShell(l, { cwd: process.cwd() }));
  for (const l of ["grep -rn other\\|reboot src", "cat docs/fdisk.md", "echo hi | wc -l", "git status"]) assert.equal(clean(l), true, l);
  for (const l of ["sh -c 'ls'", "sh <<EOF\nls\nEOF", "sh <<< ls", "eval ls", "xargs ls", "find . -exec ls {} ;", "python -c 'x'", "f() { ls; }; f", "echo $(ls", ""]) assert.equal(clean(l), false, l);
});

test("rawFloors keeps its word match for its other callers", () => {
  for (const g of GROUPS) assert.equal(rawFloors(`grep -rn other\\|${g.prog} src`)?.rule, g.rule, g.name);
});

test("gate level: a nested shell call of a script, and every shell tool, refuses a real program of each group", () => {
  const deps = { env: (cwd: string) => baseFloorEnv(cwd) };
  for (const g of GROUPS) {
    const line = g.args ? `${g.prog} ${g.args}` : g.prog;
    for (const tool of ["bash", "foreman_bg", "bg_run"]) {
      const res = gateDecide(tool, { command: `true; ${line}` }, process.cwd(), deps) as { block?: true; rule?: string } | undefined;
      assert.ok(res?.block, `${tool} ${g.name}`);
      assert.equal(res?.rule, g.rule, `${tool} ${g.name}`);
    }
    // the same program inside a script given to a shell
    const inner = gateDecide("bash", { command: `sh -c '${line}'` }, process.cwd(), deps) as { block?: true; rule?: string } | undefined;
    assert.equal(inner?.rule, g.rule, `sh -c ${g.name}`);
  }
});
