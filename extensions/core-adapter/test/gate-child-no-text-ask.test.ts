// PR A (perms-fix) A3, brief-6: no text-only floor hit becomes a parent ask for a child (git-config included); read-looking child lines decide locally.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-notextask-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [path.join(wt, "config"), scr]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "config", "a.json"), "{}");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const run = (command: string, child = true) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { ...(child ? { child: true } : {}) }), roots: () => roots(child), });
const isAsk = (o: ReturnType<typeof run>): boolean => typeof o.result === "object" && o.result !== null && "ask" in o.result && o.result.ask === true;

test("child: a heredoc into the scratch dir naming git config, then echo and ls of it, is a write-in allow with no ask", () => {
  const s = scr.replaceAll("\\", "/"); // a backslash spelling is an escape in the shell text
  const out = run(`cat > ${s}/notes.md <<'EOF'\nrun git config user.email x@example.org first\nEOF\necho done && ls ${s}`);
  assert.equal(isAsk(out), false, JSON.stringify(out.result));
  assert.equal(out.danger, null, JSON.stringify(out.danger));
  // no result and no danger: a write inside the child's scratch dir, which the mode step lets run
  assert.equal(out.result, undefined);
});

test("child: the same through $FOREMAN_SCRATCH", () => {
  const out = run("cat > $FOREMAN_SCRATCH/notes.md <<'EOF'\nrun git config user.email x@example.org first\nEOF\necho done && ls $FOREMAN_SCRATCH");
  assert.equal(isAsk(out), false, JSON.stringify(out.result));
  assert.equal(out.danger, null, JSON.stringify(out.danger));
});

test("child: a loop of grep over the config files is opaque with no ask, ls of config/ is a read allow", () => {
  const loop = run('for f in config/*.json; do grep -n foo "$f"; done');
  assert.equal(isAsk(loop), false, JSON.stringify(loop.result));
  assert.equal(loop.danger?.name ?? null, "danger-opaque", JSON.stringify(loop.danger));
  const ls = run("ls -la config/");
  assert.equal(isAsk(ls), false, JSON.stringify(ls.result));
  assert.equal(ls.danger?.name ?? null, null, JSON.stringify(ls.danger));
});

test("child loop variable: a loop body stays opaque, never a default write-in allow", () => {
  for (const l of ['for f in a.json b.json; do grep -n foo "$f"; done', "for f in *; do rm -rf $f/; done", "for f in 'a /etc/outside'; do rm -rf $f; done"]) {
    const out = run(l);
    assert.equal(isAsk(out), false, `${l}: ${JSON.stringify(out.result)}`);
    assert.equal(out.danger?.name ?? null, "danger-opaque", `${l}: ${JSON.stringify(out.danger)}`);
  }
});

test("child: ${FOREMAN_SCRATCH} resolves on a pipe line like the unbraced form", () => {
  for (const l of ["cp x $FOREMAN_SCRATCH/a | cat", "cp x ${FOREMAN_SCRATCH}/a | cat"]) {
    const out = run(l);
    assert.equal(isAsk(out), false, `${l}: ${JSON.stringify(out.result)}`);
    assert.equal(out.danger?.name ?? null, null, `${l}: ${JSON.stringify(out.danger)}`);
  }
});

test("child: opaque text-only hits on every floor are never an ask", () => {
  for (const l of [
    "for b in $L; do git push origin $b; done",
    "for b in $L; do git config core.hooksPath $b; done",
    "for b in $L; do git remote add o $b; done",
    "for f in $L; do tee .pi/permissions.json < $f; done",
    "for f in $L; do cp $f .workflow/permissions.json; done",
  ]) {
    const out = run(l);
    assert.equal(isAsk(out), false, `${l}: ${JSON.stringify(out.result)}`);
  }
});
