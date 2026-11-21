import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell } from "../psunits.ts";
import { readBaseline } from "../baseline.ts";
import { GRAMMAR, resolveVars } from "../shellvars.ts";
import { effectCtx } from "../effects.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";
import { trackedTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fx = JSON.parse(fs.readFileSync(path.join(PKG, "tests", "fixtures", "shellvars-cases.json"), "utf8")) as {
  cwd: string;
  scratch: string;
  cases: Array<{ line: string; inGrammar: boolean; lastWord: string | null }>;
};

// ledger item 7d: the fixture is read by shell_write_guard.py too (tests/test_shellvars_cases.py)
test("shared cases: grammar membership and the resolved word of the last command", () => {
  for (const c of fx.cases) {
    const p = parseShell(c.line);
    const res = resolveVars(p.pipelines, p.seps, { FOREMAN_SCRATCH: fx.scratch, PWD: fx.cwd }, () => false, c.line);
    if (!c.inGrammar) {
      assert.equal(res.size, 0, c.line);
      continue;
    }
    const unit = [...p.pipelines].reverse().flat().find((u) => GRAMMAR.commands.includes(u[0]))!;
    if (c.lastWord === null) assert.equal(res.has(unit), false, c.line);
    else assert.ok(res.get(unit)?.includes(c.lastWord), `${c.line} -> ${JSON.stringify(res.get(unit))}`);
  }
});

const w = fs.realpathSync(trackedTmp("pf-varscases-"));
const ws = path.join(w, "repo");
const wt = path.join(w, "repo.worktrees", "round");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const scratch = path.join(w, "tmp", "pi-foreman-scratch", "s1", "L1");
for (const d of [ws, wt, path.join(scratch, "probe"), ag, path.join(home, ".ssh")]) fs.mkdirSync(d, { recursive: true });

// owner ruling (7d): the $S heredoc line still asks; the resolved variable buys no deterministic allow
test("a heredoc line with a $S operand gets no deterministic allow, as its literal-path line does", () => {
  const body = "\nprint(1)\nEOF";
  const bash = bashRules(readBaseline(PKG)!, {});
  const allow = (command: string): string | null => deterministicAllow(bash, command, { effects: effectCtx(wt, [scratch], process.platform), scratchDirs: [scratch], platform: process.platform });
  const viaVar = `S=$FOREMAN_SCRATCH; python3 - "$S/probe.test.ts" <<EOF${body}`;
  assert.equal(allow(viaVar), null);
  assert.equal(allow(`python3 - "${scratch}/probe.test.ts" <<EOF${body}`), null);
});
