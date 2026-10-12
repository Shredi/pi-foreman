import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, parseShell, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
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

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-varscases-")));
const ws = path.join(w, "repo");
const wt = path.join(w, "repo.worktrees", "round");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const scratch = path.join(w, "tmp", "pi-foreman-scratch", "s1", "L1");
for (const d of [ws, wt, path.join(scratch, "probe"), ag, path.join(home, ".ssh")]) fs.mkdirSync(d, { recursive: true });
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, ag, ws, undefined, false);
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules, "bash", { command }, { cwd: wt, home, platform: process.platform, role, scratch } as MatchCtx)?.kind ?? "pass";
const ssh = path.join(home, ".ssh");

test("R3b literal lines: cd, S=$FOREMAN_SCRATCH and a later $S operand or redirect never ask", () => {
  for (const role of ["child", "main"] as const) {
    assert.equal(sh(role, `cd ${wt}; S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > $S/tc.txt`), "pass", role);
    assert.equal(sh(role, `S=$FOREMAN_SCRATCH; mkdir -p $S; npm test > "$S/tc.txt"`), "pass", role);
  }
});

test("a heredoc line keeps its class: the $S line is decided like the same line with the literal scratch path", () => {
  const body = "\nprint(1)\nEOF";
  for (const role of ["child", "main"] as const) {
    assert.equal(sh(role, `S=$FOREMAN_SCRATCH; python3 - "$S/probe.test.ts" <<EOF${body}`), sh(role, `python3 - "${scratch}/probe.test.ts" <<EOF${body}`), role);
  }
});

test("cd <literal> and NAME=$PWD make a later protected path visible to the rules", () => {
  assert.equal(sh("main", `cat ${ssh}/id_rsa`), "deny");
  assert.equal(sh("main", `cd ${ssh}; H=$PWD; cat $H/id_rsa`), "deny");
  assert.equal(sh("main", `cd ${home}; H=$PWD/.ssh; cat "$H/id_rsa"`), "deny");
  assert.equal(sh("main", `cd ${wt}; H=$PWD; cat $H/id_rsa`), "pass", "a path under the worktree is not protected");
});
