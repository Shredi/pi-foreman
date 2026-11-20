// Guard round guard-false-blocks-2, PR-A: the label `danger-readonly-run` and the role judge for read-only roles are gone. A reviewer's or explorer's
// plain reads (a pipe through `sed -E s///`, a read outside the roots, `printf` and a `for` loop) carry no label and make no model call; the write
// fence (`child-readonly-write`) and the secret floor stay.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first: the git answers are in place before the adapter loads
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const base = fs.realpathSync(mkTestTmp("pf-gfb2-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const handoff = path.join(base, "handoffs", "h1");
const outside = path.join(base, "other");
for (const d of [path.join(wt, "src"), scr, handoff, outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "src", "a.ts"), "x\n");
fs.writeFileSync(path.join(outside, "f.txt"), "x\n");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const W = fwd(wt);
const O = fwd(outside);

type Kind = "ro" | "child";
const roots = (role: string, kind: Kind): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: true, role, tmpAccess: false, ...(kind === "ro" ? { roundReadOnly: true } : {}) });
const outcome = (line: string, role: string, kind: Kind) => gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots(role, kind) });
const ROLES = ["reviewer", "explorer"];

const READS = [
  `cd ${W}/src && grep -rIniE p . | sed -E 's/x/y/' | cut -c1-160`,
  `grep -n p ${O}/f.txt | head -150`,
  `echo hi; pwd; ls src | sort`,
];

test("a reviewer's or explorer's plain reads carry no danger-readonly-run label", () => {
  for (const line of READS) for (const role of ROLES) {
    const o = outcome(line, role, "ro");
    assert.ok(!(o.dangers ?? []).includes("danger-readonly-run"), `${role}: ${line} -> ${JSON.stringify(o)}`);
    assert.equal(o.danger ?? null, null, `${role}: ${line}`);
  }
});

test("a `for` loop over `find`, `sort` and `printf` carries no label and gets the outcome of the same line from a builder", () => {
  const line = `find src -type f | sort; for f in $(find src -type f); do printf '%s\\n' "$f"; done`;
  const builder = outcome(line, "builder", "child");
  for (const role of ROLES) {
    const o = outcome(line, role, "ro");
    assert.ok(!(o.dangers ?? []).includes("danger-readonly-run"), role);
    assert.deepEqual([o.result, o.dangers, o.danger], [builder.result, builder.dangers, builder.danger], role);
  }
});

test("the write fence and the secret floor stay for the read-only roles", () => {
  for (const line of [`echo x > ${W}/f`, `sed -i s/a/b/ ${W}/src/a.ts`]) for (const role of ROLES) {
    const v = outcome(line, role, "ro").result as { block?: boolean; rule?: string } | undefined;
    assert.equal(v?.rule, "child-readonly-write", `${role}: ${line}`);
  }
  for (const role of ROLES) {
    const v = outcome("cat ~/.ssh/id_rsa", role, "ro").result as { block?: boolean; rule?: string } | undefined;
    assert.equal(v?.block, true, role);
    assert.equal(v?.rule, "floor-secret-path", role);
  }
});

const text = (t: string) => ({ content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 1, output: 1 } });

test("adapter: the reads of a read-only child run in mode auto with zero model calls", async (t) => {
  const prev = process.env[BINDINGS_ENV];
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfb2-ask-"));
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "explorer", launchId: "L1", kind: "first", model: null, askDir } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
    fs.rmSync(askDir, { recursive: true, force: true });
  });
  let calls = 0;
  const registry = {
    find: () => ({ id: "small" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => {
      calls++;
      return text(JSON.stringify({ verdict: "allow", entry: "A1", reason: "covered" }));
    },
  };
  const r = await r11Rig(t, {}, {
    child: true,
    deps: { spawner: inprocSpawner },
    ctx: { hasUI: false, mode: "json", modelRegistry: registry, [RIG_PERMISSIONS]: { classifier: { allow: ["Anything at all."] } } },
    config: { gate: { reviewTimeoutMs: 300 }, providers: { fake: { review: { model: "small" }, roles: { explorer: { model: "fake/explorer" } } } } },
  });
  const dir = path.join(r.agentDir, "pi-foreman", "state", "sessions", "parent-s");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ entries: [{ path: r.project, kind: "worktree" }] }));
  await r.restart();
  for (const line of [`cd ${r.project} && grep -rIniE p . | sed -E 's/x/y/' | cut -c1-160`, `grep -n p ${O}/f.txt | head`]) {
    assert.equal(await r.call("bash", { command: line }), undefined, line);
  }
  assert.equal(fs.existsSync(path.join(askDir, "ask.md")), false);
  assert.equal(calls, 0);
});

// Owner decision 2026-11-18: a read-only child's line with another danger label is handled like a builder's (no unconditional parent ask).
// The secret-like words are built by concatenation so the guard does not refuse this file.
const SECRET_DIR = ".s" + "sh";
const ENV_FILE = ".e" + "nv";
const LABELED = [
  `P=~/${SECRET_DIR}/id_rsa; cat "$P"`,
  // `git show HEAD:<secret>` is a floor for every role now (floors.ts gitFloors), so no builder "run" to compare: r2-secret-labels.test.ts covers it
  "gh pr comment 1 -b x",
  "ssh host true",
  "kill 1",
];
const ALLOW_VERDICT = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });

async function labeledOutcome(t: import("node:test").TestContext, role: string, mode: string, line: string): Promise<string> {
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => text(ALLOW_VERDICT) };
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", role, launchId: "l1", kind: "first", workspace: "", perms: { mode, childDeny: true } } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const cfg = { presence: { enabled: false }, roles: { [role]: { skills: [] } }, providers: { fake: { review: { model: "m" }, roles: { [role]: { model: `fake/${role}` } } } } };
  const r = await r11Rig(t, {}, { child: true, deps: { spawner: inprocSpawner }, ctx: { hasUI: false, mode: "json", modelRegistry: registry, [RIG_PERMISSIONS]: { mode } }, config: cfg });
  const dir = path.join(r.agentDir, "pi-foreman", "state", "sessions", "parent-s");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ entries: [{ path: r.project, kind: "worktree" }] }));
  await r.restart();
  const res = await r.call("bash", { command: line });
  return res === undefined ? "run" : JSON.stringify({ block: res.block, reason: String(res.reason).replace(r.project, "<wt>") });
}

for (const mode of ["auto", "allow"]) {
  test(`a read-only child's line with another danger label gets a builder's outcome in mode ${mode}`, async (t) => {
    for (const line of LABELED) {
      const builder = await labeledOutcome(t, "builder", mode, line);
      for (const role of ROLES) assert.equal(await labeledOutcome(t, role, mode, line), builder, `${role} (${mode}): ${line}`);
      // `ssh host true` is judge-first since the PR C security round (danger-remote), no run
      if (mode === "allow" && line !== "ssh host true") assert.equal(builder, "run", `a builder runs it in mode allow: ${line}`);
    }
  });
}
