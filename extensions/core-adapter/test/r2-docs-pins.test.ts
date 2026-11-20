// Guard round 2: pins of two claims in docs/safety.md. (1) `find <harness folder>` carries danger-harness-folder for every role.
// (2) a git `--output=<file>` / `--output <file>` (log, diff) is refused for a reviewer and explorer when the file lands in the worktree, and with the cwd in the worktree
// wherever it lands; a shell redirect into the scratch folder is free. Each row is one literal outcome "<verdict> <rule> <sorted labels>". Lines are data strings, never run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-r2-docs-pins-"));
after(() => rmTestTmp(base));
const home = path.join(base, "home");
const agent = path.join(home, ".pi", "agent");
const HF = path.join(agent, "pi-foreman");
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const clone = path.join(scr, "c");
const handoff = path.join(HF, "handoffs", "h1");
for (const d of [wt, clone, handoff, path.join(HF, "state")]) fs.mkdirSync(d, { recursive: true });

type Role = "main" | "builder" | "reviewer" | "explorer";
const roots = (role: Role) =>
  ({
    worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [path.join(HF, "handoffs"), HF], install: [], roundFlow: [],
    handoffs: role === "main" ? [handoff] : [], ...(role === "main" ? {} : { childHandoff: handoff }),
    child: role !== "main", role: role === "main" ? "foreman" : role, tmpAccess: role === "main", agentDir: agent, home,
    ...(role === "reviewer" || role === "explorer" ? { roundReadOnly: true } : {}),
  }) as never;
function show(line: string, role: Role, cwd = wt): string {
  const o = gateEvaluate("bash", { command: line }, cwd, { env: (c) => ({ ...baseFloorEnv(c, role === "main" ? {} : { child: true }), home, agentDir: agent }), roots: () => roots(role) });
  const r = o.result as { block?: boolean; allow?: boolean; ask?: boolean; rule?: string } | undefined;
  return `${r ? (r.block ? "block" : r.allow ? "allow" : r.ask ? "ask" : "other") : "undecided"} ${r?.rule ?? ""} ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
}

// C: `danger-harness-folder` left the judge-first list (docs/safety.md is updated in the docs step): the read runs, for every role
test("find <harness folder> carries no label for any role (C: the harness-folder label is gone)", { skip: posixOnly }, () => {
  const line = `find ${HF}`;
  for (const role of ["main", "builder", "reviewer", "explorer"] as const) assert.equal(show(line, role), "undecided  []", role);
});

test("a child reads another session's subagent-artifacts and the agent-dir foreman.json: no rule refuses the read for any role", { skip: posixOnly }, () => {
  const cfg = path.join(agent, "foreman.json");
  const sub = path.join(agent, "sessions", "x", "subagent-artifacts");
  const file = path.join(sub, "a.md");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(cfg, "{}\n");
  fs.writeFileSync(file, "x\n");
  const decide = (tool: string, input: unknown, role: Role): string => {
    const o = gateEvaluate(tool, input, wt, { env: (c) => ({ ...baseFloorEnv(c, role === "main" ? {} : { child: true }), home, agentDir: agent }), roots: () => roots(role) });
    const r = o.result as { block?: boolean; allow?: boolean; ask?: boolean; rule?: string } | undefined;
    return `${r ? (r.block ? "block" : r.allow ? "allow" : r.ask ? "ask" : "other") : "undecided"} ${r?.rule ?? ""} ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
  };
  for (const [role, shellLabels] of [["builder", "[]"], ["reviewer", "[]"], ["explorer", "[]"]] as const) {
    assert.equal(show(`cat ${cfg}`, role), `undecided  ${shellLabels}`, `${role} cat foreman.json`);
    assert.equal(decide("read", { path: cfg }, role), "undecided  []", `${role} read foreman.json`);
    assert.equal(show(`cat ${file}`, role), `undecided  ${shellLabels}`, `${role} cat subagent-artifacts`);
    assert.equal(decide("read", { path: file }, role), "undecided  []", `${role} read subagent-artifacts`);
    assert.equal(show(`grep -r x ${sub}`, role), `undecided  ${shellLabels}`, `${role} grep subagent-artifacts`);
  }
});

test("git log|diff --output=<f> and --output <f>: refused when f lands in the worktree, or with the cwd in the worktree; free from a scratch clone into scratch", { skip: posixOnly }, () => {
  const REFUSED = "block child-readonly-write []";
  const FREE = "undecided  []";
  for (const role of ["reviewer", "explorer"] as const) {
    for (const sub of ["log", "diff"]) {
      for (const form of ["--output=", "--output "]) {
        const into = (f: string): string => `git ${sub} ${form}${f}`;
        assert.equal(show(into(`${wt}/x`), role, wt), REFUSED, `${role} cwd worktree, file in worktree: ${sub} ${form}`);
        assert.equal(show(into(`${wt}/x`), role, clone), REFUSED, `${role} cwd clone, file in worktree: ${sub} ${form}`);
        assert.equal(show(into("x"), role, wt), REFUSED, `${role} cwd worktree, relative file: ${sub} ${form}`);
        assert.equal(show(into(`${scr}/x`), role, wt), REFUSED, `${role} cwd worktree, file in scratch: ${sub} ${form}`);
        assert.equal(show(into(`${scr}/x`), role, clone), FREE, `${role} cwd clone, file in scratch: ${sub} ${form}`);
        assert.equal(show(into("x"), role, clone), FREE, `${role} cwd clone, relative file: ${sub} ${form}`);
      }
      for (const cwd of [wt, clone]) assert.equal(show(`git ${sub} > ${scr}/x`, role, cwd), "allow default-git-read []", `${role} redirect into scratch: ${sub}`);
    }
  }
});
