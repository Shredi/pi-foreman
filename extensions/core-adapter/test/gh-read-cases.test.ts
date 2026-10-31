// Handover cases for the r79 rules-first rewrite of the gh/glab read default (ledger LEDGER-gh-read-search, items 1-2).
// Rows live in tests/fixtures/gh-read-cases.json: {line, expect, child?, today, note}. `today` says whether today's rules already
// give `expect`. today:true rows are live assertions; today:false rows are node:test `todo` (they run, a failure does not fail the
// suite). When the r79 rule lands, flip `today` to true per row. The graphql rule must parse conservatively: any mutation or
// subscription anywhere (second `-f query=`, other field, same document), any @file, --input or -H keeps the line not-allow.
// Quoting cases for PowerShell/cmd are not applicable: the lexer does not split them (see the powershell test below).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const base = fs.realpathSync(mkTestTmp("pf-ghread-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
for (const d of [path.join(wt, "src"), scr, path.join(base, "pi")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [], install: [path.join(base, "pi")], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, ...o,
});
const facts: GitFacts = { currentBranch: () => "round/41-x", protectedBranches: () => ["main", "master", "trunk"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: "/pf41/home", agentDir: "/pf41/agent", platform: process.platform, protectedBranches: ["trunk"], currentBranch: () => "round/41-x", remoteHead: () => "trunk", writeRoots: [wt, scr, tmpDir, "/tmp"] };
const CHILD = { child: true, role: "builder" };

const g = (tool: string, input: Record<string, unknown>, r: Partial<GateRoots> = {}): GateResult =>
  gateDecide(tool, input, wt, { env: () => env, roots: () => roots(r), facts });
const kind = (r: GateResult): string => (!r ? "pass" : "allow" in r ? "allow" : "block");
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule : null);

interface Row { line: string; expect: "allow" | "not-allow"; child?: boolean; today: boolean; note: string }
const rows: Row[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "gh-read-cases.json"), "utf8"));
const expand = (l: string): string => l.replaceAll("<scratch>", shPath(scr)).replaceAll("<worktree>", shPath(wt));
const decide = (row: Row): GateResult => g("bash", { command: expand(row.line) }, row.child ? CHILD : {});

for (const row of rows) {
  const name = `${row.expect} ${row.child ? "[child] " : ""}${row.line} (${row.note})`;
  const opts = row.today ? {} : { todo: "r79: gh read set (search, graphql query, GET with fields)" };
  test(name, opts, () => {
    const r = decide(row);
    if (row.expect === "allow") {
      assert.equal(kind(r), "allow", row.line);
      assert.match(rule(r) ?? "", /default-gh-read/, row.line);
    } else assert.notEqual(kind(r), "allow", row.line);
  });
}

test("meta: every not-allow row is already refused today (writes must never be a todo)", () => {
  const bad = rows.filter((r) => r.expect === "not-allow" && !r.today);
  assert.deepEqual(bad.map((r) => r.line), []);
});

test("powershell: gh search is no default allow (the lexer does not split PowerShell/cmd, so quoting cases there are not applicable)", () => {
  assert.notEqual(kind(g("powershell", { command: "gh search prs x" })), "allow");
});
