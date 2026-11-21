import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell } from "../psunits.ts";
import { GRAMMAR, resolveVars } from "../shellvars.ts";

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
